//! The items of a listing, packed into one buffer.
//!
//! UniFFI's Swift glue reads a record field by field through `Data`, which
//! costs several microseconds an item: a listing of 10,000 notes took 70 ms to
//! read into Swift against 13 ms to list. A listing therefore crosses as one
//! buffer that the Swift package reads in one pass (`PackedRows.swift` in
//! withmarfa/marfa-swift), and each item in it reads as the `Item` record
//! would.
//!
//! The layout, with every integer little-endian:
//!
//! - The buffer: `FORMAT` as a `u32`, a `u32` count, then that many items.
//! - An item, its fields in the order `Item` declares them: `id`, `type` and
//!   `properties`; `state` as one byte (0 active, 1 archived, 2 trashed, 3
//!   revoked); `tier` as one byte (0 none, 1 library, 2 feed); `version` and
//!   `schema_version` as `i64`; `source`; `source_id` as an optional text;
//!   `occurred_at`, `created_at` and `updated_at`; `tags` as a `u32` count and
//!   that many texts; `capture_latitude` and `capture_longitude` as optional
//!   `f64`; `title`, `body` and `unreadable_properties` as optional texts.
//! - A text: a `u32` length in bytes, then its UTF-8.
//! - An optional: one byte, 0 for none or 1 followed by the value.
//! - An `f64`: its IEEE 754 bits as a `u64`.
//! - A value: one byte, 0 null, 1 false, 2 true, 3 an integer as `i64`, 4 a
//!   number as `f64`, 5 a text, 6 an array as a `u32` count and that many
//!   values, 7 an object. A number is an integer where `JsonValue` would hold
//!   it as one.
//! - An object: a `u32` count, then that many pairs of a text key and a value.

use marfa_core::{Item, ItemState, Shown, Tier};
use serde_json::{Map, Value};

/// The layout's version. A change to the layout, or to `Item` or `JsonValue`,
/// changes it, and the Swift package refuses a buffer of another version.
pub(crate) const FORMAT: u32 = 1;

pub(crate) fn pack(rows: &[(Item, Shown)]) -> Vec<u8> {
    let mut packer = Packer(Vec::with_capacity(8 + rows.len() * 256));
    packer.0.extend_from_slice(&FORMAT.to_le_bytes());
    packer.count(rows.len());
    for (item, shown) in rows {
        packer.item(item, shown);
    }
    packer.0
}

struct Packer(Vec<u8>);

impl Packer {
    fn count(&mut self, count: usize) {
        // A listing's rows, a row's tags and a value's members are each far
        // below `u32::MAX`, as is any text the server takes.
        let count = u32::try_from(count).expect("a count beyond u32 in a listing");
        self.0.extend_from_slice(&count.to_le_bytes());
    }

    fn byte(&mut self, byte: u8) {
        self.0.push(byte);
    }

    fn i64(&mut self, value: i64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }

    fn f64(&mut self, value: f64) {
        self.0.extend_from_slice(&value.to_bits().to_le_bytes());
    }

    fn text(&mut self, text: &str) {
        self.count(text.len());
        self.0.extend_from_slice(text.as_bytes());
    }

    fn optional_text(&mut self, text: Option<&str>) {
        match text {
            None => self.byte(0),
            Some(text) => {
                self.byte(1);
                self.text(text);
            }
        }
    }

    fn optional_f64(&mut self, value: Option<f64>) {
        match value {
            None => self.byte(0),
            Some(value) => {
                self.byte(1);
                self.f64(value);
            }
        }
    }

    fn item(&mut self, item: &Item, shown: &Shown) {
        self.text(&item.id);
        self.text(&item.r#type);
        self.object(&item.properties);
        self.byte(match item.state {
            ItemState::Active => 0,
            ItemState::Archived => 1,
            ItemState::Trashed => 2,
            ItemState::Revoked => 3,
        });
        self.byte(match item.tier {
            None => 0,
            Some(Tier::Library) => 1,
            Some(Tier::Feed) => 2,
        });
        self.i64(item.version);
        self.i64(item.schema_version);
        self.text(&item.source);
        self.optional_text(item.source_id.as_deref());
        self.text(&item.occurred_at);
        self.text(&item.created_at);
        self.text(&item.updated_at);
        self.count(item.tags.len());
        for tag in &item.tags {
            self.text(tag);
        }
        self.optional_f64(item.capture_latitude);
        self.optional_f64(item.capture_longitude);
        self.optional_text(shown.title.as_deref());
        self.optional_text(shown.body.as_deref());
        self.optional_text(shown.unreadable_properties.as_deref());
    }

    fn object(&mut self, object: &Map<String, Value>) {
        self.count(object.len());
        for (key, value) in object {
            self.text(key);
            self.value(value);
        }
    }

    fn value(&mut self, value: &Value) {
        match value {
            Value::Null => self.byte(0),
            Value::Bool(false) => self.byte(1),
            Value::Bool(true) => self.byte(2),
            Value::Number(number) => match number.as_i64() {
                Some(integer) => {
                    self.byte(3);
                    self.i64(integer);
                }
                None => {
                    self.byte(4);
                    self.f64(number.as_f64().unwrap_or(f64::NAN));
                }
            },
            Value::String(text) => {
                self.byte(5);
                self.text(text);
            }
            Value::Array(values) => {
                self.byte(6);
                self.count(values.len());
                for value in values {
                    self.value(value);
                }
            }
            Value::Object(object) => {
                self.byte(7);
                self.object(object);
            }
        }
    }
}

/// Reads what `pack` wrote, for the binding's own tests, refusing what the
/// Swift package's reader refuses.
#[cfg(test)]
pub(crate) fn unpack(bytes: &[u8]) -> Vec<crate::Item> {
    let mut reader = Reader(bytes, 0);
    let format = reader.count();
    assert_eq!(format, FORMAT as usize, "a listing of format {format}");
    let count = reader.count();
    let items = (0..count).map(|_| reader.item()).collect();
    assert!(reader.0.is_empty(), "bytes left after the last item");
    items
}

/// The bytes left to read, and how deep the value being read nests.
#[cfg(test)]
struct Reader<'a>(&'a [u8], usize);

#[cfg(test)]
impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let (head, rest) = self.0.split_at(N);
        self.0 = rest;
        head.try_into().unwrap()
    }

    fn byte(&mut self) -> u8 {
        self.take::<1>()[0]
    }

    fn count(&mut self) -> usize {
        u32::from_le_bytes(self.take()) as usize
    }

    fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take())
    }

    fn f64(&mut self) -> f64 {
        f64::from_bits(u64::from_le_bytes(self.take()))
    }

    fn text(&mut self) -> String {
        let length = self.count();
        let (head, rest) = self.0.split_at(length);
        self.0 = rest;
        String::from_utf8(head.to_vec()).unwrap()
    }

    fn optional<T>(&mut self, read: impl FnOnce(&mut Self) -> T) -> Option<T> {
        match self.byte() {
            0 => None,
            1 => Some(read(self)),
            other => panic!("an optional marked {other}"),
        }
    }

    fn item(&mut self) -> crate::Item {
        use crate::{ItemState, Tier};
        crate::Item {
            id: self.text(),
            r#type: self.text(),
            properties: self.object(),
            state: match self.byte() {
                0 => ItemState::Active,
                1 => ItemState::Archived,
                2 => ItemState::Trashed,
                3 => ItemState::Revoked,
                other => panic!("a state marked {other}"),
            },
            tier: match self.byte() {
                0 => None,
                1 => Some(Tier::Library),
                2 => Some(Tier::Feed),
                other => panic!("a tier marked {other}"),
            },
            version: self.i64(),
            schema_version: self.i64(),
            source: self.text(),
            source_id: self.optional(Self::text),
            occurred_at: self.text(),
            created_at: self.text(),
            updated_at: self.text(),
            tags: (0..self.count()).map(|_| self.text()).collect(),
            capture_latitude: self.optional(Self::f64),
            capture_longitude: self.optional(Self::f64),
            title: self.optional(Self::text),
            body: self.optional(Self::text),
            unreadable_properties: self.optional(Self::text),
        }
    }

    /// The properties object is the first level, as `MAX_JSON_DEPTH` counts.
    fn nest(&mut self) {
        self.1 += 1;
        assert!(
            self.1 <= marfa_core::MAX_JSON_DEPTH,
            "a value nested deeper than {}",
            marfa_core::MAX_JSON_DEPTH
        );
    }

    fn object(&mut self) -> crate::JsonObject {
        self.nest();
        let members = (0..self.count())
            .map(|_| crate::JsonMember {
                key: self.text(),
                value: self.value(),
            })
            .collect();
        self.1 -= 1;
        crate::JsonObject { members }
    }

    fn value(&mut self) -> crate::JsonValue {
        use crate::JsonValue;
        match self.byte() {
            0 => JsonValue::Null,
            1 => JsonValue::Bool(false),
            2 => JsonValue::Bool(true),
            3 => JsonValue::Integer(self.i64()),
            4 => JsonValue::Number(self.f64()),
            5 => JsonValue::String(self.text()),
            6 => {
                self.nest();
                let values = (0..self.count()).map(|_| self.value()).collect();
                self.1 -= 1;
                JsonValue::Array(values)
            }
            7 => JsonValue::Object(self.object()),
            other => panic!("a value marked {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn every_field() -> (Item, Shown) {
        let properties = json!({
            "null": null,
            "no": false,
            "yes": true,
            "integer": i64::MIN,
            "number": -0.5,
            "text": "é ✓ \u{0}",
            "array": [1, []],
            "object": { "": null },
        });
        let item = Item {
            id: "a".into(),
            r#type: "core.note".into(),
            properties: properties.as_object().unwrap().clone(),
            state: ItemState::Revoked,
            tier: Some(Tier::Feed),
            version: 7,
            schema_version: 2,
            source: "device".into(),
            source_id: Some("source".into()),
            occurred_at: "2026-01-01T00:00:00Z".into(),
            created_at: "2026-01-02T00:00:00Z".into(),
            updated_at: "2026-01-03T00:00:00Z".into(),
            tags: vec!["x".into(), "".into()],
            capture_latitude: Some(51.5),
            capture_longitude: Some(-0.12),
        };
        let shown = Shown {
            title: Some("Title".into()),
            body: Some(String::new()),
            unreadable_properties: Some("why".into()),
        };
        (item, shown)
    }

    fn plain() -> (Item, Shown) {
        let (item, _) = every_field();
        let item = Item {
            id: "id".into(),
            properties: json!({ "k": 1 }).as_object().unwrap().clone(),
            state: ItemState::Active,
            tier: None,
            version: i64::MAX,
            source_id: None,
            tags: vec![],
            capture_latitude: None,
            capture_longitude: None,
            ..item
        };
        let shown = Shown {
            title: None,
            body: None,
            unreadable_properties: None,
        };
        (item, shown)
    }

    fn text(bytes: &mut Vec<u8>, text: &str) {
        bytes.extend((text.len() as u32).to_le_bytes());
        bytes.extend(text.as_bytes());
    }

    fn times(bytes: &mut Vec<u8>) {
        for at in [
            "2026-01-01T00:00:00Z",
            "2026-01-02T00:00:00Z",
            "2026-01-03T00:00:00Z",
        ] {
            text(bytes, at);
        }
    }

    #[test]
    fn every_field_and_value_reads_back_as_the_record_would_cross() {
        let (item, none) = plain();
        let archived = Item {
            state: ItemState::Archived,
            tier: Some(Tier::Library),
            ..item.clone()
        };
        let trashed = Item {
            state: ItemState::Trashed,
            ..item.clone()
        };
        let wide = Item {
            properties: json!({ "big": u64::MAX, "small": i64::MIN, "large": 1e300 })
                .as_object()
                .unwrap()
                .clone(),
            ..item.clone()
        };
        let rows = vec![
            every_field(),
            (item, none.clone()),
            (archived, none.clone()),
            (trashed, none.clone()),
            (wide, none),
        ];
        let crossed: Vec<crate::Item> = rows
            .iter()
            .map(|(item, shown)| crate::item(item.clone(), shown.clone()))
            .collect();
        assert_eq!(unpack(&pack(&rows)), crossed);
        assert_eq!(unpack(&pack(&[])), vec![]);
    }

    /// The bytes the Swift package's `PackedListing.agreed` holds.
    #[test]
    fn the_layout_of_a_plain_item_is_the_one_the_swift_package_reads() {
        let mut expected = vec![1, 0, 0, 0, 1, 0, 0, 0];
        text(&mut expected, "id");
        text(&mut expected, "core.note");
        expected.extend([1, 0, 0, 0, 1, 0, 0, 0, b'k', 3, 1, 0, 0, 0, 0, 0, 0, 0]);
        expected.extend([0, 0]);
        expected.extend(i64::MAX.to_le_bytes());
        expected.extend(2i64.to_le_bytes());
        text(&mut expected, "device");
        expected.push(0);
        times(&mut expected);
        expected.extend([0, 0, 0, 0]);
        expected.extend([0, 0, 0, 0, 0]);
        assert_eq!(pack(&[plain()]), expected);
    }

    /// The bytes the Swift package's `PackedListing.fullBytes` holds: every
    /// value tag, every optional present, `f64`s, tags, and the state and
    /// tier codes the plain item leaves out.
    #[test]
    fn the_layout_of_a_full_item_is_the_one_the_swift_package_reads() {
        let mut expected = vec![1, 0, 0, 0, 1, 0, 0, 0];
        text(&mut expected, "a");
        text(&mut expected, "core.note");
        expected.extend([8, 0, 0, 0]);
        text(&mut expected, "null");
        expected.push(0);
        text(&mut expected, "no");
        expected.push(1);
        text(&mut expected, "yes");
        expected.push(2);
        text(&mut expected, "integer");
        expected.push(3);
        expected.extend(i64::MIN.to_le_bytes());
        text(&mut expected, "number");
        expected.push(4);
        expected.extend((-0.5f64).to_bits().to_le_bytes());
        text(&mut expected, "text");
        expected.push(5);
        text(&mut expected, "é ✓ \u{0}");
        text(&mut expected, "array");
        expected.extend([6, 2, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0]);
        text(&mut expected, "object");
        expected.extend([7, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        expected.extend([3, 2]);
        expected.extend(7i64.to_le_bytes());
        expected.extend(2i64.to_le_bytes());
        text(&mut expected, "device");
        expected.push(1);
        text(&mut expected, "source");
        times(&mut expected);
        expected.extend([2, 0, 0, 0]);
        text(&mut expected, "x");
        text(&mut expected, "");
        expected.push(1);
        expected.extend(51.5f64.to_bits().to_le_bytes());
        expected.push(1);
        expected.extend((-0.12f64).to_bits().to_le_bytes());
        expected.push(1);
        text(&mut expected, "Title");
        expected.push(1);
        text(&mut expected, "");
        expected.push(1);
        text(&mut expected, "why");
        assert_eq!(pack(&[every_field()]), expected);
    }

    #[test]
    #[should_panic(expected = "nested deeper")]
    fn the_test_reader_refuses_a_value_nested_past_the_limit_as_the_swift_one_does() {
        let nested = |arrays: usize| {
            let deep = (0..arrays).fold(json!(null), |inner, _| json!([inner]));
            let (item, shown) = plain();
            let item = Item {
                properties: json!({ "deep": deep }).as_object().unwrap().clone(),
                ..item
            };
            pack(&[(item, shown)])
        };
        unpack(&nested(marfa_core::MAX_JSON_DEPTH - 1));
        unpack(&nested(marfa_core::MAX_JSON_DEPTH));
    }
}
