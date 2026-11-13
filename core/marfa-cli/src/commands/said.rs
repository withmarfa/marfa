//! The one line a write prints: what it did, and the id and the title or name
//! of what it changed.

use serde_json::Value;

use crate::output::printable;

fn text<'a>(record: &'a Value, name: &str) -> &'a str {
    record.get(name).and_then(Value::as_str).unwrap_or("")
}

/// The id, and the title or name where the record carries one, as `id "title"`.
pub fn called(record: &Value) -> String {
    let property = |name: &str| {
        record
            .get("properties")
            .and_then(|properties| properties.get(name))
            .and_then(Value::as_str)
    };
    let title = property("title")
        .or_else(|| property("name"))
        .or_else(|| record.get("title").and_then(Value::as_str))
        .or_else(|| record.get("name").and_then(Value::as_str))
        .and_then(|title| title.lines().next())
        .unwrap_or("");
    let id = text(record, "id");
    if title.is_empty() {
        printable(id)
    } else {
        format!("{} \"{}\"", printable(id), printable(title))
    }
}

/// An answer that wraps the item it wrote, as `created note 01a1 "Soup"`.
pub fn item(verb: &str, answer: &Value) -> String {
    let record = answer.get("item").unwrap_or(answer);
    let mut line = format!("{verb} {}", called(record));
    if let Some(kind) = record.get("type").and_then(Value::as_str) {
        line = format!("{verb} {} {}", printable(kind), called(record));
    }
    if let Some(version) = record.get("version").and_then(Value::as_u64) {
        line.push_str(&format!(" (version {version})"));
    }
    if answer.get("acknowledged") == Some(&Value::Bool(true)) {
        line.push_str("; the server already held this write");
    }
    line
}

/// An answer that wraps the item's metadata: the tags it now has.
pub fn tags(verb: &str, id: &str, answer: &Value) -> String {
    let tags: Vec<&str> = answer
        .pointer("/metadata/tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let now = if tags.is_empty() {
        "no tags".to_string()
    } else {
        tags.iter()
            .map(|tag| printable(tag))
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!("{verb} {}; it now has {now}", printable(id))
}

/// A batch of table rows: what became of each, counted, and the batch's id.
pub fn rows(table: &str, answer: &Value) -> String {
    let results = answer
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut kinds: Vec<(String, usize)> = Vec::new();
    for result in &results {
        let outcome = text(result, "outcome");
        match kinds.iter_mut().find(|(seen, _)| seen == outcome) {
            Some((_, count)) => *count += 1,
            None => kinds.push((outcome.to_string(), 1)),
        }
    }
    let ids: Vec<&str> = results.iter().map(|result| text(result, "id")).collect();
    let what = match (results.len(), kinds.as_slice()) {
        (1, [(outcome, _)]) => format!("{outcome} row {}", printable(ids[0])),
        (_, kinds) => {
            let parts: Vec<String> = kinds
                .iter()
                .map(|(outcome, count)| format!("{count} {outcome}"))
                .collect();
            format!("rows: {}", parts.join(", "))
        }
    };
    let batch = text(answer, "batch");
    let undid = match answer.get("undoes").and_then(Value::as_str) {
        Some(undone) => format!(" (undoing batch {})", printable(undone)),
        None => String::new(),
    };
    format!(
        "{what} in {} as batch {}{undid}",
        printable(table),
        printable(batch)
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_written_item_is_named_by_its_id_and_its_title() {
        let answer = json!({"item": {
            "id": "i1", "type": "core.note", "version": 3,
            "properties": {"title": "Soup\nand more"},
        }});
        assert_eq!(
            item("updated", &answer),
            "updated core.note i1 \"Soup\" (version 3)"
        );
        let named = json!({"item": {"id": "t1", "type": "core.entity.person", "properties": {"name": "Ada"}}});
        assert_eq!(
            item("created", &named),
            "created core.entity.person t1 \"Ada\""
        );
        let untitled = json!({"id": "x"});
        assert_eq!(called(&untitled), "x");
        let held = json!({"item": {"id": "i1", "type": "core.note"}, "acknowledged": true});
        assert!(item("created", &held).ends_with("; the server already held this write"));
    }

    #[test]
    fn what_a_text_could_do_to_the_terminal_is_escaped_in_the_line() {
        let hostile = json!({"id": "i1", "properties": {"title": "a\u{1b}[2Kb"}});
        assert!(!called(&hostile).contains('\u{1b}'));
    }

    #[test]
    fn tags_name_what_the_item_now_has() {
        let answer = json!({"metadata": {"item_id": "i1", "tags": ["a", "b"]}});
        assert_eq!(tags("tagged", "i1", &answer), "tagged i1; it now has a, b");
        let none = json!({"metadata": {"item_id": "i1", "tags": []}});
        assert_eq!(
            tags("untagged", "i1", &none),
            "untagged i1; it now has no tags"
        );
    }

    #[test]
    fn a_batch_of_rows_says_what_became_of_them() {
        let put = json!({"batch": "b1", "results": [{"id": "r1", "outcome": "created"}]});
        assert_eq!(rows("pantry", &put), "created row r1 in pantry as batch b1");
        let deleted = json!({"batch": "b2", "results": [
            {"id": "r1", "outcome": "deleted"}, {"id": "r2", "outcome": "absent"},
            {"id": "r3", "outcome": "deleted"},
        ]});
        assert_eq!(
            rows("pantry", &deleted),
            "rows: 2 deleted, 1 absent in pantry as batch b2"
        );
        let undone =
            json!({"batch": "b3", "undoes": "b2", "results": [{"id": "r1", "outcome": "created"}]});
        assert_eq!(
            rows("pantry", &undone),
            "created row r1 in pantry as batch b3 (undoing batch b2)"
        );
    }
}
