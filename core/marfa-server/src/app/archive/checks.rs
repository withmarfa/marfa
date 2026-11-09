//! The checks a restore makes of every line of an archive, which an export makes of what it
//! writes, so an archive the export sends is one the restore takes whole.
//!
//! Each check judges one line on its own, against the catalog the archive's registrations make.
//! The checks that need the whole archive or the instance it lands in (a second line with an id,
//! a key or a snapshot id already read, an edge's cardinality and cycles, rows the instance
//! already holds) are the restore's, made where it writes.

use marfa_rules::time;
use serde_json::{Map, Value, json};

use crate::app::catalog::Catalog;
use crate::app::edges::write::judge_restored_ends;
use crate::app::items::bulk::BULK_REQUEST_BYTES;
use crate::app::items::write::ruled;
use crate::app::refusal::{Code, Refusal};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const TIERS: [&str; 2] = ["library", "feed"];
const STATES: [&str; 4] = ["active", "archived", "trashed", "revoked"];

/// Which kind of line a refusal is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Item,
    Edge,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Item => "item",
            Kind::Edge => "edge",
        }
    }
}

/// A line a restore would refuse or skip: the row, the field, and what the restore answers.
#[derive(Debug)]
pub struct Refused {
    pub kind: Kind,
    pub id: Option<String>,
    pub type_id: Option<String>,
    pub field: Option<String>,
    /// The refusal a restore answers, or for a line it skips, the reason under `code`.
    pub refusal: Refusal,
    /// Where a restore skips the line rather than refusing the archive, the reason it counts.
    pub skip: Option<String>,
}

impl Refused {
    /// The row as an export's refusal names it in `details.row`.
    pub fn row(&self) -> Value {
        json!({
            "kind": self.kind.word(),
            "id": self.id,
            "type": self.type_id,
            "field": self.field,
            "code": self.refusal.code.wire(),
        })
    }
}

/// The line being judged, which each refusal names.
struct At<'a> {
    kind: Kind,
    id: Option<&'a str>,
    type_id: Option<&'a str>,
    row: usize,
}

impl At<'_> {
    fn refused(&self, field: Option<&str>, refusal: Refusal) -> Box<Refused> {
        let named = format!("{}_id", self.kind.word());
        let refusal = refusal
            .with_detail("row", self.row)
            .with_detail(&named, self.id.map(str::to_string));
        Box::new(Refused {
            kind: self.kind,
            id: self.id.map(str::to_string),
            type_id: self.type_id.map(str::to_string),
            field: field.map(str::to_string),
            refusal: match field {
                Some(field) => refusal.with_detail("field", field),
                None => refusal,
            },
            skip: None,
        })
    }

    fn invalid(&self, field: &str, expected: &str) -> Box<Refused> {
        let message = format!(
            "{} {} on line {} of the archive: {field} must be {expected}.",
            capitalized(self.kind.word()),
            self.id.unwrap_or("with no id"),
            self.row
        );
        self.refused(Some(field), Refusal::validation(message))
    }

    /// A line a restore skips rather than refuses, for `reason`.
    fn skipped(&self, field: Option<&str>, reason: &str, what: &str) -> Box<Refused> {
        let message = format!(
            "A restore would skip {what} on line {} of the archive.",
            self.row
        );
        let mut refused = self.refused(field, Refusal::validation(message));
        refused.refusal = refused.refusal.with_detail("reason", reason);
        refused.skip = Some(reason.to_string());
        refused
    }
}

impl At<'_> {
    /// An edge a restore skips, counted under the code `POST /edges` refuses it with.
    fn skipping(&self, refusal: Refusal) -> Box<Refused> {
        let reason = refusal.code.wire().to_string();
        let mut refused = self.refused(None, refusal);
        refused.skip = Some(reason);
        refused
    }
}

fn capitalized(word: &str) -> String {
    let mut letters = word.chars();
    letters
        .next()
        .map(|first| first.to_ascii_uppercase().to_string() + letters.as_str())
        .unwrap_or_default()
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn is_instant(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| time::rfc3339(text, "at").is_ok())
}

fn is_version(value: &Value) -> bool {
    value
        .as_i64()
        .is_some_and(|version| (1..=MAX_SAFE_INTEGER).contains(&version))
}

fn is_type_id(text: &str) -> bool {
    marfa_rules::grammar::type_id(text).unwrap_or(false)
}

const WRITER_KINDS: [&str; 4] = ["browser", "app", "key", "local"];

fn printable(text: &str) -> bool {
    let count = text.chars().count();
    (1..=200).contains(&count) && !text.chars().any(crate::app::sources::hidden)
}

/// Where a writer is not `null` or a writer as a version names one, the field that is wrong.
fn writer_fault(value: &Value) -> Option<&'static str> {
    let writer = match value {
        Value::Null => return None,
        Value::Object(writer) => writer,
        _ => return Some(""),
    };
    let text = |key: &str| writer.get(key).and_then(Value::as_str);
    if !text("kind").is_some_and(|kind| WRITER_KINDS.contains(&kind)) {
        return Some("kind");
    }
    if !text("id").is_some_and(printable) {
        return Some("id");
    }
    if !text("name").is_some_and(|name| printable(name) && name.trim() == name) {
        return Some("name");
    }
    None
}

fn writer_field(field: &str, fault: &str) -> String {
    if fault.is_empty() {
        field.to_string()
    } else {
        format!("{field}.{fault}")
    }
}

/// The size `properties` take as the bulk operations read them.
fn size_of(properties: &Value) -> usize {
    serde_json::to_string(properties).map_or(usize::MAX, |text| text.len())
}

fn oversized(at: &At<'_>, field: &str, properties: &Value) -> Option<Box<Refused>> {
    let bytes = size_of(properties);
    (bytes > BULK_REQUEST_BYTES).then(|| {
        let message = format!(
            "{} {} on line {} of the archive: {field} is {bytes} bytes, more than the {BULK_REQUEST_BYTES} a \
             write takes.",
            capitalized(at.kind.word()),
            at.id.unwrap_or("with no id"),
            at.row
        );
        at.refused(
            Some(field),
            Refusal::new(Code::RequestTooLarge, message).with_detail("limit_bytes", BULK_REQUEST_BYTES),
        )
    })
}

/// Whether a row of `type_id` can be in `state`: the bin holds no `system.*` row, and only a
/// `system.*` row is revoked.
fn state_held(type_id: &str, state: &str) -> bool {
    let system = crate::app::items::is_system(type_id);
    STATES.contains(&state) && !(system && state == "trashed") && !(!system && state == "revoked")
}

/// Judges an `items.ndjson` line, the `row`th, as a restore into an instance holding `catalog`.
pub fn item(catalog: &Catalog, line: &Value, row: usize) -> Result<(), Box<Refused>> {
    let unnamed = At {
        kind: Kind::Item,
        id: None,
        type_id: None,
        row,
    };
    let Some(item) = line.get("item").and_then(Value::as_object) else {
        return Err(unnamed.skipped(None, "malformed", "an item line it cannot read"));
    };
    let id = item.get("id").and_then(Value::as_str);
    let type_id = item.get("type").and_then(Value::as_str);
    let at = At {
        kind: Kind::Item,
        id,
        type_id,
        row,
    };
    if item.get("id").is_some_and(|id| {
        !id.as_str()
            .is_some_and(|id| marfa_rules::validation::id("id", id).is_ok())
    }) {
        return Err(at.invalid("id", "an item ID"));
    }
    let Some(type_id) = type_id.filter(|type_id| is_type_id(type_id)) else {
        return Err(at.invalid("type", "a type identifier"));
    };
    for field in ["created_at", "updated_at", "occurred_at"] {
        if item.get(field).is_some_and(|value| !is_instant(value)) {
            return Err(at.invalid(field, "an instant"));
        }
    }
    if item.get("version").is_some_and(|value| !is_version(value)) {
        return Err(at.invalid("version", "a positive safe integer"));
    }
    let binned = matches!(
        item.get("state").and_then(Value::as_str),
        Some("trashed" | "revoked")
    );
    if let Some(trashed_at) = item.get("trashed_at").filter(|value| !value.is_null()) {
        if !is_instant(trashed_at) {
            return Err(at.invalid("trashed_at", "an instant or null"));
        }
        if !binned {
            return Err(at.invalid("trashed_at", "null outside the bin and the revoked state"));
        }
    }
    if item
        .get("tier")
        .is_some_and(|tier| !tier.as_str().is_some_and(|tier| TIERS.contains(&tier)))
    {
        return Err(at.invalid("tier", "library or feed"));
    }
    if let Some(state) = item.get("state")
        && !state
            .as_str()
            .is_some_and(|state| state_held(type_id, state))
    {
        let message = format!(
            "Item {} of type {type_id} is recorded in a state its lifecycle cannot produce.",
            id.unwrap_or("with no id")
        );
        return Err(at.refused(Some("state"), Refusal::validation(message)));
    }
    let properties = match item.get("properties") {
        None => None,
        Some(Value::Object(properties)) => Some(properties),
        Some(_) => {
            let message = format!(
                "Item {} holds properties that are not an object.",
                id.unwrap_or("with no id")
            );
            return Err(at.refused(
                Some("properties"),
                Refusal::new(Code::InvalidProperties, message),
            ));
        }
    };
    for field in ["writer", "trashed_by"] {
        if let Some(fault) = line.get(field).and_then(writer_fault) {
            return Err(at.invalid(&writer_field(field, fault), "a writer or null"));
        }
    }
    if line
        .get("restored_at")
        .is_some_and(|value| !value.is_null() && !is_instant(value))
    {
        return Err(at.invalid("restored_at", "an instant or null"));
    }
    let version = item.get("version").and_then(Value::as_i64).unwrap_or(1);
    history(&at, line.get("versions"), id, version)?;
    if let Some(refused) = item
        .get("properties")
        .and_then(|properties| oversized(&at, "properties", properties))
    {
        return Err(refused);
    }
    if let Some(Value::Array(versions)) = line.get("versions") {
        for (index, snapshot) in versions.iter().enumerate() {
            if let Some(refused) = snapshot
                .get("properties")
                .and_then(|held| oversized(&at, &format!("versions.{index}.properties"), held))
            {
                return Err(refused);
            }
        }
    }
    let empty = Map::new();
    shape(catalog, &at, type_id, properties.unwrap_or(&empty))
}

/// A row of a type this build ships is held to that type, and an event's schedule or a task's
/// recurrence to what a calendar read can unfold, whatever type it is.
fn shape(
    catalog: &Catalog,
    at: &At<'_>,
    type_id: &str,
    properties: &Map<String, Value>,
) -> Result<(), Box<Refused>> {
    let rules = &catalog.rules;
    let judged = if Catalog::ships(type_id) {
        rules.validate_properties(type_id, properties, true)
    } else if rules.known(type_id) {
        rules.judge_schedule(type_id, properties)
    } else {
        Ok(())
    };
    judged.map_err(|error| {
        let field = error.fields.first().map(|field| {
            if field.path.starts_with('_') {
                field.path.clone()
            } else {
                format!("properties.{}", field.path)
            }
        });
        at.refused(field.as_deref(), ruled(error))
    })
}

/// A row's history: an array of snapshots of the row, each below its version and none twice.
fn history(
    at: &At<'_>,
    versions: Option<&Value>,
    id: Option<&str>,
    version: i64,
) -> Result<(), Box<Refused>> {
    let Some(versions) = versions else {
        return Ok(());
    };
    let Some(versions) = versions.as_array() else {
        return Err(at.invalid("versions", "an array of snapshots"));
    };
    let mut seen = std::collections::HashSet::new();
    for (index, snapshot) in versions.iter().enumerate() {
        let field = |name: &str| format!("versions.{index}.{name}");
        let Some(snapshot) = snapshot.as_object() else {
            return Err(at.invalid(&format!("versions.{index}"), "a snapshot"));
        };
        if !text(snapshot, "id").is_some_and(|id| marfa_rules::validation::id("id", id).is_ok()) {
            return Err(at.invalid(&field("id"), "a snapshot ID"));
        }
        if text(snapshot, "item_id") != id {
            return Err(at.invalid(&field("item_id"), "the item's own ID"));
        }
        if !snapshot.get("properties").is_some_and(Value::is_object) {
            return Err(at.invalid(&field("properties"), "an object"));
        }
        if !text(snapshot, "type").is_some_and(is_type_id) {
            return Err(at.invalid(&field("type"), "a type identifier"));
        }
        if !snapshot
            .get("tier")
            .is_some_and(|tier| tier.is_null() || tier.as_str().is_some_and(|t| TIERS.contains(&t)))
        {
            return Err(at.invalid(&field("tier"), "library, feed or null"));
        }
        for name in ["created_at", "occurred_at"] {
            if !snapshot.get(name).is_some_and(is_instant) {
                return Err(at.invalid(&field(name), "an instant"));
            }
        }
        if let Some(fault) = snapshot.get("writer").and_then(writer_fault) {
            return Err(at.invalid(&writer_field(&field("writer"), fault), "a writer or null"));
        }
        if !snapshot
            .get("source_id")
            .is_some_and(|source_id| source_id.is_null() || source_id.is_string())
        {
            return Err(at.invalid(&field("source_id"), "a string or null"));
        }
        let held = snapshot.get("version").and_then(Value::as_i64);
        if !held.is_some_and(|held| (1..version).contains(&held)) || !seen.insert(held) {
            return Err(at.invalid(
                &field("version"),
                "a positive safe integer below the item's version, once in its history",
            ));
        }
    }
    Ok(())
}

/// An edge's end, as a restore finds it once the archive's items are written.
pub struct End<'a> {
    pub type_id: &'a str,
}

/// Judges an `edges.ndjson` line, the `row`th, whose ends `ends` finds, as a restore into an
/// instance holding `catalog`.
pub fn edge<'a>(
    catalog: &Catalog,
    line: &Value,
    row: usize,
    ends: impl Fn(&str) -> Option<End<'a>>,
) -> Result<(), Box<Refused>> {
    let unnamed = At {
        kind: Kind::Edge,
        id: None,
        type_id: None,
        row,
    };
    let Some(edge) = line.get("edge").and_then(Value::as_object) else {
        return Err(unnamed.skipped(None, "malformed", "an edge line it cannot read"));
    };
    let id = text(edge, "id");
    let edge_type = text(edge, "edge_type");
    let at = At {
        kind: Kind::Edge,
        id,
        type_id: edge_type,
        row,
    };
    for field in ["created_at", "updated_at"] {
        if edge.get(field).is_some_and(|value| !is_instant(value)) {
            return Err(at.invalid(field, "an instant"));
        }
    }
    if let Some(edge_type) = edge_type
        && !marfa_rules::schema::edge_id(edge_type)
    {
        return Err(at.invalid("edge_type", "an edge-type identifier"));
    }
    if edge.get("version").is_some_and(|value| !is_version(value)) {
        return Err(at.invalid("version", "a positive safe integer"));
    }
    if let Some(refused) = edge
        .get("properties")
        .and_then(|properties| oversized(&at, "properties", properties))
    {
        return Err(refused);
    }
    let (Some(source_id), Some(target_id), Some(edge_type)) =
        (text(edge, "source_id"), text(edge, "target_id"), edge_type)
    else {
        return Err(at.skipped(
            None,
            "malformed",
            "an edge that does not name its ends and type",
        ));
    };
    let (Some(source), Some(target)) = (ends(source_id), ends(target_id)) else {
        return Err(at.skipped(
            None,
            "endpoint_missing",
            "an edge whose end it does not hold",
        ));
    };
    if source_id == target_id {
        let message = "Edge source and target must be different items";
        return Err(at.skipping(Refusal::new(Code::EdgeCycle, message)));
    }
    let Some(kind) = catalog.edge_kind(edge_type) else {
        return Ok(());
    };
    judge_restored_ends(catalog, kind, (source_id, source.type_id), target.type_id)
        .map_err(|refusal| at.skipping(refusal))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn line(item: Value) -> Value {
        json!({ "item": item, "metadata": { "tags": [], "extensions": {} } })
    }

    fn note(extra: Value) -> Value {
        let mut item = json!({
            "id": "01a1bdba-8640-72ba-b7d6-9e27d94e7540",
            "type": "core.note",
            "version": 3,
            "properties": { "title": "a note" },
        });
        if let (Some(item), Value::Object(extra)) = (item.as_object_mut(), extra) {
            item.extend(extra);
        }
        item
    }

    fn snapshot(version: i64) -> Value {
        json!({
            "id": "01a1bdba-866a-70a7-87aa-e9c809bcd0e5",
            "item_id": "01a1bdba-8640-72ba-b7d6-9e27d94e7540",
            "version": version,
            "properties": {},
            "type": "core.note",
            "tier": null,
            "created_at": "2026-11-09T00:00:00.000Z",
            "occurred_at": "2026-11-09T00:00:00.000Z",
            "source_id": null,
        })
    }

    fn field(refused: Result<(), Box<Refused>>) -> Option<String> {
        refused.err().and_then(|refused| refused.field)
    }

    #[test]
    fn a_writer_is_judged_field_by_field() {
        assert_eq!(writer_fault(&Value::Null), None);
        assert_eq!(
            writer_fault(&json!({ "kind": "key", "id": "k", "name": "Desk" })),
            None
        );
        assert_eq!(writer_fault(&json!("a key")), Some(""));
        assert_eq!(
            writer_fault(&json!({ "kind": "robot", "id": "k", "name": "x" })),
            Some("kind")
        );
        assert_eq!(
            writer_fault(&json!({ "kind": "key", "id": "", "name": "x" })),
            Some("id")
        );
        assert_eq!(
            writer_fault(&json!({ "kind": "key", "id": "k", "name": "a\u{7}b" })),
            Some("name")
        );
        assert_eq!(
            writer_fault(&json!({ "kind": "key", "id": "k", "name": " x" })),
            Some("name")
        );
    }

    #[test]
    fn a_row_its_type_takes_passes() {
        let catalog = Catalog::shipped();
        assert!(item(&catalog, &line(note(json!({}))), 1).is_ok());
        let history = json!({ "versions": [snapshot(1), snapshot(2)] });
        let mut held = line(note(json!({})));
        held.as_object_mut()
            .unwrap()
            .extend(history.as_object().unwrap().clone());
        assert!(item(&catalog, &held, 1).is_ok());
    }

    #[test]
    fn a_row_in_a_state_its_lifecycle_cannot_produce_is_refused() {
        let catalog = Catalog::shipped();
        let revoked = line(note(json!({ "state": "revoked" })));
        assert_eq!(field(item(&catalog, &revoked, 1)).as_deref(), Some("state"));
        let trashed = line(note(json!({ "state": "trashed" })));
        assert!(item(&catalog, &trashed, 1).is_ok());
    }

    #[test]
    fn a_snapshot_at_or_above_the_rows_version_or_repeated_is_refused() {
        let catalog = Catalog::shipped();
        for versions in [json!([snapshot(3)]), json!([snapshot(1), snapshot(1)])] {
            let mut held = line(note(json!({})));
            held["versions"] = versions;
            let refused = field(item(&catalog, &held, 1)).unwrap();
            assert!(refused.ends_with(".version"), "{refused}");
        }
    }

    #[test]
    fn properties_past_the_bulk_cap_are_refused_and_at_it_pass() {
        let catalog = Catalog::shipped();
        let at = BULK_REQUEST_BYTES - r#"{"t":""}"#.len();
        let fits = line(
            json!({ "id": "01a1bdba-8640-72ba-b7d6-9e27d94e7540", "type": "user.thing", "properties": { "t": "a".repeat(at) } }),
        );
        assert!(item(&catalog, &fits, 1).is_ok());
        let over = line(
            json!({ "id": "01a1bdba-8640-72ba-b7d6-9e27d94e7540", "type": "user.thing", "properties": { "t": "a".repeat(at + 1) } }),
        );
        let refused = item(&catalog, &over, 1).unwrap_err();
        assert_eq!(refused.refusal.code, Code::RequestTooLarge);
        assert_eq!(refused.field.as_deref(), Some("properties"));
    }

    #[test]
    fn a_row_of_a_type_nothing_registers_keeps_its_shape_and_a_shipped_type_does_not() {
        let catalog = Catalog::shipped();
        let orphan = line(
            json!({ "id": "01a1bdba-8640-72ba-b7d6-9e27d94e7540", "type": "user.gone", "properties": { "n": 1 } }),
        );
        assert!(item(&catalog, &orphan, 1).is_ok());
        let wrong = line(note(json!({ "properties": { "title": 7 } })));
        let refused = item(&catalog, &wrong, 1).unwrap_err();
        assert_eq!(refused.refusal.code, Code::InvalidProperties);
        assert_eq!(refused.field.as_deref(), Some("properties.title"));
    }

    #[test]
    fn an_edge_names_a_kind_and_both_ends_or_is_judged_as_a_restore_would() {
        let catalog = Catalog::shipped();
        let ends = |id: &str| {
            (id != "missing").then_some(End {
                type_id: "core.note",
            })
        };
        let edge_line = |edge_type: &str, target: &str| {
            json!({ "edge": {
                "id": "e", "source_id": "a", "target_id": target, "edge_type": edge_type,
                "version": 1, "properties": {},
            }, "lending_blobs": [] })
        };
        assert!(edge(&catalog, &edge_line("about", "b"), 1, ends).is_ok());
        assert!(edge(&catalog, &edge_line("user.gone", "b"), 1, ends).is_ok());
        let bad = edge(&catalog, &edge_line("Not An Id", "b"), 1, ends).unwrap_err();
        assert_eq!(bad.field.as_deref(), Some("edge_type"));
        let missing = edge(&catalog, &edge_line("about", "missing"), 1, ends).unwrap_err();
        assert_eq!(
            missing.refusal.details.unwrap()["reason"],
            "endpoint_missing"
        );
        let looped = edge(&catalog, &edge_line("about", "a"), 1, ends).unwrap_err();
        assert_eq!(looped.refusal.code, Code::EdgeCycle);
    }
}
