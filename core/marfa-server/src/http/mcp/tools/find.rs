//! `marfa_find`: short entries for the items, and the rows, a search or a listing names.

use std::sync::Arc;

use marfa_rules::search;
use marfa_rules::validation::MAX_TAG_LENGTH;
use serde_json::{Map, Value, json};

use super::{Definition, parsed, text, texts};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items;
use crate::http::listing::{ITEMS_QUERY, Params, SEARCH_QUERY, items_from, search_from};
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_find";

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;
const SNIPPET_CHARS: usize = 160;

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Find items",
        description: "Use to find notes, tasks, records, files and other items: search by words, or list by type, tags, source or dates. Returns short entries (id, type, title, snippet, and the table row a search matched); read the full items with marfa_get and a row with marfa_read_rows.",
        input: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "minLength": 1,
                    "description": format!("Words to search for, at most {} characters and {} distinct words. Leave out to list items in order instead.", search::MAX_QUERY_CHARS, search::MAX_QUERY_TERMS) },
                "type": { "type": "string", "minLength": 1,
                    "description": "Only items of this type or its subtypes, such as `core.note`; `core.*` matches every type under `core`." },
                "tags": { "type": "array", "items": { "type": "string", "minLength": 1 },
                    "description": format!("Only items that carry all of these tags, at most {} distinct tags of {} characters each.", search::MAX_FILTER_TAGS, MAX_TAG_LENGTH) },
                "source": { "type": "string", "minLength": 1,
                    "description": "Only items saved by this source." },
                "state": { "type": "string", "enum": ["active", "archived", "trashed", "any"],
                    "description": "Which items by state; `active` when left out. A search never finds trashed items." },
                "tier": { "type": "string", "enum": ["library", "feed", "all"],
                    "description": "`library` for what the person kept, `feed` for what arrived from connectors; both when left out." },
                "updated_after": { "type": "string",
                    "description": "Only items changed at or after this time (RFC 3339)." },
                "updated_before": { "type": "string",
                    "description": "Only items changed before this time (RFC 3339)." },
                "occurred_after": { "type": "string",
                    "description": "Only items whose own time, such as a meeting's date, is at or after this time." },
                "occurred_before": { "type": "string",
                    "description": "Only items whose own time is before this time." },
                "sort": { "type": "string", "enum": ["relevance", "updated_at", "created_at", "occurred_at"],
                    "description": "Order: `relevance` for a search (its default), otherwise `updated_at` by default." },
                "direction": { "type": "string", "enum": ["asc", "desc"] },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT,
                    "description": format!("How many entries, {DEFAULT_LIMIT} when left out.") },
                "cursor": { "type": "string", "minLength": 1,
                    "description": "next_cursor from the previous answer, for the next page." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "items": { "type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "type": { "type": "string" },
                        "title": { "type": "string" },
                        "snippet": { "type": "string" },
                        "state": { "type": "string" },
                        "updated_at": { "type": "string" },
                        "occurred_at": { "type": "string" },
                        "row": {
                            "type": "object",
                            "description": "The row of the item's table that the search matched, and the column it matched in.",
                            "properties": {
                                "table": { "type": "string" },
                                "id": { "type": "string" },
                                "column": { "type": "string" },
                            },
                            "required": ["table", "id", "column"],
                        },
                    },
                    "required": ["id", "type", "title", "updated_at"],
                } },
                "next_cursor": { "type": ["string", "null"] },
                "hint": { "type": "string" },
            },
            "required": ["items", "next_cursor"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

const ESCAPED: [(&str, char); 5] = [
    ("&amp;", '&'),
    ("&lt;", '<'),
    ("&gt;", '>'),
    ("&quot;", '"'),
    ("&#39;", '\''),
];

fn collapsed(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A search excerpt as text: its only markup is `<mark>` and five escapes.
fn excerpt_text(html: &str) -> String {
    let bare = html.replace("<mark>", "").replace("</mark>", "");
    let mut out = String::with_capacity(bare.len());
    let mut rest = bare.as_str();
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match ESCAPED.iter().find(|(entity, _)| rest.starts_with(entity)) {
            Some((entity, point)) => {
                out.push(*point);
                rest = &rest[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    collapsed(&out)
}

fn clip(text: &str) -> String {
    let points: Vec<char> = text.chars().collect();
    if points.len() > SNIPPET_CHARS {
        let mut kept: String = points.iter().take(SNIPPET_CHARS - 1).collect();
        kept.push('…');
        kept
    } else {
        text.to_string()
    }
}

/// A short preview that never repeats the title.
fn preview(item: &Value, title: &str, caption: Option<&str>) -> String {
    if let Some(body) = caption.filter(|body| !body.is_empty()) {
        return clip(body);
    }
    for field in ["description", "notes", "summary"] {
        let Some(value) = item
            .get("properties")
            .and_then(|properties| properties.get(field))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let value = collapsed(value);
        if !value.is_empty() && value != title {
            return clip(&value);
        }
    }
    String::new()
}

struct Entry {
    item: Value,
    snippet_html: Option<String>,
    row: Option<Value>,
}

fn short(entry: &Entry, caption: Option<&items::Caption>) -> Value {
    let item = &entry.item;
    let field = |name: &str| item.get(name).and_then(Value::as_str);
    let title = caption.map_or("Untitled", |caption| caption.name.as_str());
    let snippet = match &entry.snippet_html {
        Some(html) => clip(&excerpt_text(html)),
        None => preview(
            item,
            title,
            caption.and_then(|caption| caption.preview.as_deref()),
        ),
    };
    let mut row = Map::new();
    row.insert("id".into(), field("id").unwrap_or_default().into());
    row.insert("type".into(), field("type").unwrap_or_default().into());
    row.insert("title".into(), title.into());
    if !snippet.is_empty() {
        row.insert("snippet".into(), snippet.into());
    }
    if let Some(state) = field("state").filter(|state| *state != "active") {
        row.insert("state".into(), state.into());
    }
    row.insert(
        "updated_at".into(),
        field("updated_at").unwrap_or_default().into(),
    );
    if let Some(occurred) = field("occurred_at").filter(|at| Some(*at) != field("created_at")) {
        row.insert("occurred_at".into(), occurred.into());
    }
    if let Some(named) = &entry.row {
        row.insert("row".into(), named.clone());
    }
    Value::Object(row)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT);
    let state = text(&arguments, "state");
    let sort = text(&arguments, "sort");
    let query = text(&arguments, "query");
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut add = |name: &str, value: Option<String>| {
        if let Some(value) = value {
            pairs.push((name.to_string(), value));
        }
    };
    add("type", text(&arguments, "type"));
    let tags = texts(&arguments, "tags");
    add("tags", (!tags.is_empty()).then(|| tags.join(",")));
    for name in [
        "source",
        "tier",
        "updated_after",
        "updated_before",
        "occurred_after",
        "occurred_before",
        "cursor",
    ] {
        add(name, text(&arguments, name));
    }
    add("limit", Some(limit.to_string()));
    add("state", state.clone());

    let entries = match query {
        Some(words) => {
            if state.as_deref() == Some("trashed") {
                return Err(Stop::invalid(
                    "A search never finds trashed items. Leave out query to list the trash.",
                ));
            }
            add("direction", text(&arguments, "direction"));
            add("sort", sort);
            add("q", Some(words));
            let params = Params::from_pairs(pairs, &SEARCH_QUERY)?;
            let page = parsed(&search_from(app, caller, &params).await?)?;
            entries_of(&page, true)
        }
        None => {
            if sort.as_deref() == Some("relevance") {
                return Err(Stop::invalid("Sorting by relevance needs query."));
            }
            add(
                "sort",
                Some(sort.unwrap_or_else(|| "updated_at".to_string())),
            );
            add(
                "direction",
                Some(text(&arguments, "direction").unwrap_or_else(|| "desc".to_string())),
            );
            let params = Params::from_pairs(pairs, &ITEMS_QUERY)?;
            let page = parsed(&items_from(app, caller, &params).await?)?;
            entries_of(&page, false)
        }
    };
    let next_cursor = entries.1;
    let ids: Vec<String> = entries
        .0
        .iter()
        .filter_map(|entry| entry.item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let captions = items::captions(app, caller, ids).await?;
    let rows: Vec<Value> = entries
        .0
        .iter()
        .map(|entry| {
            let caption = entry
                .item
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| captions.get(id));
            short(entry, caption)
        })
        .collect();
    let mut answer = Map::new();
    answer.insert("items".into(), Value::Array(rows));
    answer.insert(
        "next_cursor".into(),
        next_cursor.clone().map_or(Value::Null, Value::String),
    );
    if next_cursor.is_some() {
        answer.insert(
            "hint".into(),
            "More items match. Narrow with words, type, tags or a date range, or pass next_cursor as cursor to see the next page."
                .into(),
        );
    }
    Ok(Value::Object(answer))
}

fn entries_of(page: &Value, search: bool) -> (Vec<Entry>, Option<String>) {
    let entries = page
        .get("data")
        .and_then(Value::as_array)
        .map(|data| {
            data.iter()
                .map(|entry| {
                    if search {
                        Entry {
                            item: entry.get("item").cloned().unwrap_or(Value::Null),
                            snippet_html: entry
                                .get("snippet_html")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            row: entry.get("row").cloned(),
                        }
                    } else {
                        Entry {
                            item: entry.clone(),
                            snippet_html: None,
                            row: None,
                        }
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let next = page
        .get("next_cursor")
        .and_then(Value::as_str)
        .map(str::to_string);
    (entries, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_excerpt_loses_its_marks_and_decodes_its_five_escapes() {
        assert_eq!(
            excerpt_text("a <mark>b</mark> &amp;lt; &lt;c&gt;\n&quot;d&quot; &#39;e&#39; &copy;"),
            "a b &lt; <c> \"d\" 'e' &copy;"
        );
    }

    #[test]
    fn a_long_snippet_is_clipped_to_its_limit_with_an_ellipsis() {
        let long = "é".repeat(200);
        let clipped = clip(&long);
        assert_eq!(clipped.chars().count(), SNIPPET_CHARS);
        assert!(clipped.ends_with('…'));
        assert_eq!(clip("short"), "short");
    }
}
