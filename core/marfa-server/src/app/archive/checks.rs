//! The per-line checks a restore makes, which an export makes too.

use std::borrow::Cow;

use marfa_rules::catalog::Naming;
use marfa_rules::schema::OWN_COLUMNS;
use marfa_rules::time;
use serde_json::{Map, Value, json};

use crate::app::catalog::Catalog;
use crate::app::edges::write::judge_restored_ends;
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
    Row,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Item => "item",
            Kind::Edge => "edge",
            Kind::Row => "row",
        }
    }
}

/// A line a restore would refuse or skip: the item or edge, the field, and what the restore answers.
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
    /// The item or edge as an export's refusal names it in `details.entry`.
    pub fn entry(&self) -> Value {
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
            .with_detail("line", self.row)
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

    fn missing(&self, field: &str) -> Box<Refused> {
        let message = format!(
            "{} {} on line {} of the archive: {field} is missing.",
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

fn oversized(at: &At<'_>, cap: usize, field: &str, properties: &Value) -> Option<Box<Refused>> {
    let bytes = size_of(properties);
    (bytes > cap).then(|| {
        let message = format!(
            "{} {} on line {} of the archive: {field} is {bytes} bytes, more than the {cap} a \
             write takes.",
            capitalized(at.kind.word()),
            at.id.unwrap_or("with no id"),
            at.row
        );
        at.refused(
            Some(field),
            Refusal::new(Code::RequestTooLarge, message).with_detail("limit_bytes", cap),
        )
    })
}

/// The bin holds no `system.*` row, and only a `system.*` row is revoked.
fn state_held(type_id: &str, state: &str) -> bool {
    let system = crate::app::items::is_system(type_id);
    STATES.contains(&state) && !(system && state == "trashed") && !(!system && state == "revoked")
}

/// The fields every item line carries.
const ITEM_FIELDS: [&str; 8] = [
    "id",
    "version",
    "created_at",
    "updated_at",
    "last_activity_at",
    "occurred_at",
    "state",
    "properties",
];

/// Judges an `items.ndjson.gz` line as a restore would; `cap` is the bulk body limit.
pub fn item(catalog: &Catalog, cap: usize, line: &Value, row: usize) -> Result<(), Box<Refused>> {
    let unnamed = At {
        kind: Kind::Item,
        id: None,
        type_id: None,
        row,
    };
    if !line.is_object() {
        let message = format!("Line {row} of items.ndjson.gz must be an object.");
        return Err(unnamed.refused(None, Refusal::validation(message)));
    }
    let Some(item) = line.get("item").and_then(Value::as_object) else {
        return Err(unnamed.invalid("item", "an object"));
    };
    let id = item.get("id").and_then(Value::as_str);
    let type_id = item.get("type").and_then(Value::as_str);
    let at = At {
        kind: Kind::Item,
        id,
        type_id,
        row,
    };
    for field in ITEM_FIELDS {
        if !item.contains_key(field) {
            return Err(at.missing(field));
        }
    }
    if !id.is_some_and(|id| marfa_rules::validation::id("id", id).is_ok()) {
        return Err(at.invalid("id", "an item ID"));
    }
    let Some(type_id) = type_id.filter(|type_id| is_type_id(type_id)) else {
        return Err(at.invalid("type", "a type identifier"));
    };
    for field in [
        "created_at",
        "updated_at",
        "occurred_at",
        "last_activity_at",
    ] {
        if !item.get(field).is_some_and(is_instant) {
            return Err(at.invalid(field, "an instant"));
        }
    }
    if !item.get("version").is_some_and(is_version) {
        return Err(at.invalid("version", "a whole number from 1 to 9007199254740991"));
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
    if !item
        .get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| state_held(type_id, state))
    {
        let message = format!(
            "Item {} of type {type_id} is recorded in a state its lifecycle cannot produce.",
            id.unwrap_or("with no id")
        );
        return Err(at.refused(Some("state"), Refusal::validation(message)));
    }
    let properties = match item.get("properties") {
        Some(Value::Object(properties)) => properties,
        _ => {
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
    if let Some(refused) = item
        .get("properties")
        .and_then(|properties| oversized(&at, cap, "properties", properties))
    {
        return Err(refused);
    }
    shape(catalog, &at, type_id, properties)
}

/// A shipped type holds its items to it; any type's schedule, recurrence and kept columns must still read.
fn shape(
    catalog: &Catalog,
    at: &At<'_>,
    type_id: &str,
    properties: &Map<String, Value>,
) -> Result<(), Box<Refused>> {
    let rules = &catalog.rules;
    let judged = if Catalog::ships(type_id) {
        let written = if properties.contains_key(OWN_COLUMNS) {
            let mut written = properties.clone();
            written.remove(OWN_COLUMNS);
            Cow::Owned(written)
        } else {
            Cow::Borrowed(properties)
        };
        rules.validate_merged(type_id, properties, true, &written)
    } else if rules.known(type_id) {
        rules.judge_schedule(type_id, properties)
    } else {
        Ok(())
    };
    let judged = judged.and_then(|()| rules.judge_kept_columns(type_id, properties, Naming::Any));
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

/// A `versions.ndjson.gz` line: one earlier version of an item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionKey {
    pub item_id: String,
    pub id: String,
    pub version: i64,
}

/// Checks shape only; intake checks the item's presence and version order.
pub fn version(cap: usize, line: &Value, row: usize) -> Result<VersionKey, Box<Refused>> {
    let item_id = line.get("item_id").and_then(Value::as_str);
    let at = At {
        kind: Kind::Item,
        id: item_id,
        type_id: None,
        row,
    };
    let Some(snapshot) = line.as_object() else {
        let message = format!("Line {row} of versions.ndjson.gz must be an object.");
        return Err(at.refused(None, Refusal::validation(message)));
    };
    let Some(item_id) = item_id.filter(|id| is_id(id)) else {
        return Err(at.invalid("item_id", "an item ID"));
    };
    let Some(version) = snapshot.get("version").filter(|held| is_version(held)) else {
        return Err(at.invalid("version", "a whole number from 1 to 9007199254740991"));
    };
    let version = version.as_i64().unwrap_or_default();
    let field = |name: &str| format!("versions.{version}.{name}");
    let Some(id) = text(snapshot, "id").filter(|id| is_id(id)) else {
        return Err(at.invalid(&field("id"), "a snapshot ID"));
    };
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
    if let Some(refused) = snapshot
        .get("properties")
        .and_then(|held| oversized(&at, cap, &field("properties"), held))
    {
        return Err(refused);
    }
    Ok(VersionKey {
        item_id: item_id.to_string(),
        id: id.to_string(),
        version,
    })
}

/// The line that holds an item, an edge or a version, longer than the `cap` a restore reads.
pub fn too_long(
    kind: Kind,
    id: &str,
    type_id: &str,
    field: Option<&str>,
    bytes: usize,
    cap: usize,
) -> Refused {
    let what = match field {
        Some(field) => format!("{field} of {} {id}", kind.word()),
        None => format!("{} {id}", capitalized(kind.word())),
    };
    let message = format!(
        "{what} takes {bytes} bytes on one archive line, more than the {cap} a restore reads."
    );
    Refused {
        kind,
        id: Some(id.to_string()),
        type_id: Some(type_id.to_string()),
        field: field.map(str::to_string),
        refusal: Refusal::validation(message).with_detail("limit_bytes", cap),
        skip: None,
    }
}

/// A row line's place in the order `rows.ndjson.gz` holds: its item, its table and its id.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RowKey {
    pub item_id: String,
    pub table: String,
    pub id: String,
}

fn is_id(text: &str) -> bool {
    marfa_rules::validation::id("id", text).is_ok()
}

/// Judges a `rows.ndjson.gz` line as a restore would, and answers its place in the file.
pub fn row(line: &Value, row: usize) -> Result<RowKey, Box<Refused>> {
    let unnamed = At {
        kind: Kind::Row,
        id: None,
        type_id: None,
        row,
    };
    let Some(object) = line.as_object() else {
        let message = format!("Line {row} of rows.ndjson.gz must be an object.");
        return Err(unnamed.refused(None, Refusal::validation(message)));
    };
    let id = text(object, "id");
    let at = At {
        kind: Kind::Row,
        id,
        type_id: None,
        row,
    };
    let refused = |field: &str, expected: &str| {
        let mut refused = at.invalid(field, expected);
        refused.refusal = refused
            .refusal
            .with_detail("item_id", text(object, "item_id").map(str::to_string));
        refused
    };
    let Some(item_id) = text(object, "item_id").filter(|held| is_id(held)) else {
        return Err(refused("item_id", "an item ID"));
    };
    let Some(table) = text(object, "table").filter(|held| marfa_rules::catalog::api_name(held))
    else {
        return Err(refused("table", "a table name"));
    };
    let Some(id) = id.filter(|held| is_id(held)) else {
        return Err(refused("id", "a UUIDv7 in lowercase"));
    };
    let Some(values) = object.get("values").and_then(Value::as_object) else {
        return Err(refused("values", "an object"));
    };
    if !object.get("updated_at").is_some_and(is_instant) {
        return Err(refused("updated_at", "an instant"));
    }
    if let Some(refs) = object.get("refs") {
        let Some(columns) = refs.as_array() else {
            return Err(refused("refs", "an array of columns"));
        };
        let mut seen = std::collections::HashSet::new();
        for column in columns {
            let named = column.as_str().filter(|column| seen.insert(*column));
            if !named.is_some_and(|column| {
                values
                    .get(column)
                    .and_then(Value::as_str)
                    .is_some_and(is_id)
            }) {
                return Err(refused(
                    "refs",
                    "an array of distinct columns that each hold an item ID",
                ));
            }
        }
    }
    let bytes = marfa_rules::rows::printed_len(values);
    if bytes > marfa_rules::rows::MAX_ROW_BYTES {
        return Err(refused(
            "values",
            &format!(
                "at most {} bytes as JSON, and holds {bytes}",
                marfa_rules::rows::MAX_ROW_BYTES
            ),
        ));
    }
    Ok(RowKey {
        item_id: item_id.to_string(),
        table: table.to_string(),
        id: id.to_string(),
    })
}

/// An edge's end, as a restore finds it once the archive's items are written.
pub struct End<'a> {
    pub type_id: &'a str,
}

/// Judges an `edges.ndjson.gz` line as a restore would, finding its ends through `ends`.
pub fn edge<'a>(
    catalog: &Catalog,
    cap: usize,
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
    if edge.get("id").is_some_and(|id| {
        !id.as_str()
            .is_some_and(|id| marfa_rules::validation::id("id", id).is_ok())
    }) {
        return Err(at.invalid("id", "an edge ID"));
    }
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
        return Err(at.invalid("version", "a whole number from 1 to 9007199254740991"));
    }
    if let Some(refused) = edge
        .get("properties")
        .and_then(|properties| oversized(&at, cap, "properties", properties))
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

    const CAP: usize = 16 * 1024 * 1024;

    fn line(item: Value) -> Value {
        json!({ "item": item, "metadata": { "tags": [], "extensions": {} } })
    }

    fn note(extra: Value) -> Value {
        let mut item = json!({
            "id": "01a1bdba-8640-72ba-b7d6-9e27d94e7540",
            "type": "core.note",
            "version": 3,
            "state": "active",
            "created_at": "2026-11-09T00:00:00.000Z",
            "updated_at": "2026-11-09T00:00:00.000Z",
            "last_activity_at": "2026-11-09T00:00:00.000Z",
            "occurred_at": "2026-11-09T00:00:00.000Z",
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
    fn a_line_that_is_no_object_is_refused_by_its_line_alone() {
        let catalog = Catalog::shipped();
        for value in [Value::Null, json!(5), json!("text"), json!([{}])] {
            for refused in [
                item(&catalog, CAP, &value, 4).unwrap_err(),
                row(&value, 4).unwrap_err(),
            ] {
                let details = refused.refusal.details.as_ref().unwrap();
                assert_eq!(refused.refusal.code, Code::ValidationError);
                assert_eq!(details["line"], 4);
                assert!(!details.contains_key("field"));
                assert!(refused.field.is_none());
            }
            let skipped = edge(&catalog, CAP, &value, 4, |_| None).unwrap_err();
            assert_eq!(skipped.skip.as_deref(), Some("malformed"));
        }
    }

    #[test]
    fn an_item_line_lacking_a_field_the_server_writes_is_refused_naming_it() {
        let catalog = Catalog::shipped();
        for field in ITEM_FIELDS {
            let mut held = note(json!({}));
            held.as_object_mut().unwrap().remove(field);
            let refused = item(&catalog, CAP, &line(held), 7).unwrap_err();
            assert_eq!(refused.field.as_deref(), Some(field), "{field}");
            let message = refused.refusal.message.to_string();
            assert!(
                message.contains("line 7") && message.contains("is missing"),
                "{message}"
            );
        }
    }

    #[test]
    fn a_row_its_type_takes_passes() {
        let catalog = Catalog::shipped();
        assert!(item(&catalog, CAP, &line(note(json!({}))), 1).is_ok());
    }

    #[test]
    fn a_version_line_names_its_item_and_version() {
        let key = version(CAP, &snapshot(2), 1).unwrap();
        assert_eq!(key.item_id, "01a1bdba-8640-72ba-b7d6-9e27d94e7540");
        assert_eq!(key.version, 2);
        let mut untyped = snapshot(2);
        untyped["type"] = json!("not a type");
        let refused = version(CAP, &untyped, 4).unwrap_err();
        assert_eq!(refused.field.as_deref(), Some("versions.2.type"));
        assert_eq!(
            refused.id.as_deref(),
            Some("01a1bdba-8640-72ba-b7d6-9e27d94e7540")
        );
        let details = refused.refusal.details.unwrap();
        assert_eq!(details["item_id"], "01a1bdba-8640-72ba-b7d6-9e27d94e7540");
        assert_eq!(details["line"], 4);
    }

    #[test]
    fn a_row_in_a_state_its_lifecycle_cannot_produce_is_refused() {
        let catalog = Catalog::shipped();
        let revoked = line(note(json!({ "state": "revoked" })));
        assert_eq!(
            field(item(&catalog, CAP, &revoked, 1)).as_deref(),
            Some("state")
        );
        let trashed = line(note(json!({ "state": "trashed" })));
        assert!(item(&catalog, CAP, &trashed, 1).is_ok());
    }

    #[test]
    fn a_version_that_is_no_whole_number_or_whose_properties_pass_the_cap_is_refused() {
        for held in [json!(0), json!(1.5), json!("2")] {
            let mut line = snapshot(1);
            line["version"] = held;
            let refused = version(CAP, &line, 1).unwrap_err();
            assert_eq!(refused.field.as_deref(), Some("version"));
        }
        let mut large = snapshot(1);
        large["properties"] = json!({ "t": "a".repeat(100) });
        let size = r#"{"t":""}"#.len() + 100;
        assert!(version(size, &large, 1).is_ok());
        let refused = version(size - 1, &large, 1).unwrap_err();
        assert_eq!(refused.refusal.code, Code::RequestTooLarge);
        assert_eq!(refused.field.as_deref(), Some("versions.1.properties"));
    }

    #[test]
    fn properties_past_the_bulk_cap_are_refused_and_at_it_pass() {
        let catalog = Catalog::shipped();
        let at = CAP - r#"{"t":""}"#.len();
        let fits = line(note(
            json!({ "type": "user.thing", "properties": { "t": "a".repeat(at) } }),
        ));
        assert!(item(&catalog, CAP, &fits, 1).is_ok());
        let over = line(note(
            json!({ "type": "user.thing", "properties": { "t": "a".repeat(at + 1) } }),
        ));
        let refused = item(&catalog, CAP, &over, 1).unwrap_err();
        assert_eq!(refused.refusal.code, Code::RequestTooLarge);
        assert_eq!(refused.field.as_deref(), Some("properties"));
    }

    #[test]
    fn the_cap_is_the_one_the_instance_sets() {
        let catalog = Catalog::shipped();
        let row = line(note(
            json!({ "type": "user.thing", "properties": { "t": "a".repeat(100) } }),
        ));
        let size = r#"{"t":""}"#.len() + 100;
        assert!(item(&catalog, size, &row, 1).is_ok());
        let refused = item(&catalog, size - 1, &row, 1).unwrap_err();
        assert_eq!(refused.refusal.code, Code::RequestTooLarge);
    }

    #[test]
    fn a_row_of_a_type_nothing_registers_keeps_its_shape_and_a_shipped_type_does_not() {
        let catalog = Catalog::shipped();
        let orphan = line(note(
            json!({ "type": "user.gone", "properties": { "n": 1 } }),
        ));
        assert!(item(&catalog, CAP, &orphan, 1).is_ok());
        let wrong = line(note(json!({ "properties": { "title": 7 } })));
        let refused = item(&catalog, CAP, &wrong, 1).unwrap_err();
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
        let edge_with = |id: Value, edge_type: &str, target: &str| {
            json!({ "edge": {
                "id": id, "source_id": "a", "target_id": target, "edge_type": edge_type,
                "version": 1, "properties": {},
            }, "lending_blobs": [] })
        };
        let edge_line = |edge_type: &str, target: &str| {
            edge_with(
                json!("01a1bdba-8640-72ba-b7d6-9e27d94e7541"),
                edge_type,
                target,
            )
        };
        assert!(edge(&catalog, CAP, &edge_line("about", "b"), 1, ends).is_ok());
        for id in [
            json!("e"),
            json!(7),
            json!("01A1BDBA-8640-72BA-B7D6-9E27D94E7541"),
        ] {
            let refused = edge(&catalog, CAP, &edge_with(id, "about", "b"), 1, ends).unwrap_err();
            assert_eq!(refused.field.as_deref(), Some("id"));
            assert!(refused.skip.is_none());
        }
        assert!(edge(&catalog, CAP, &edge_line("user.gone", "b"), 1, ends).is_ok());
        let bad = edge(&catalog, CAP, &edge_line("Not An Id", "b"), 1, ends).unwrap_err();
        assert_eq!(bad.field.as_deref(), Some("edge_type"));
        let missing = edge(&catalog, CAP, &edge_line("about", "missing"), 1, ends).unwrap_err();
        assert_eq!(
            missing.refusal.details.unwrap()["reason"],
            "endpoint_missing"
        );
        let looped = edge(&catalog, CAP, &edge_line("about", "a"), 1, ends).unwrap_err();
        assert_eq!(looped.refusal.code, Code::EdgeCycle);
    }
}
