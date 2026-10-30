//! The items of a listing, packed into one buffer.
//!
//! UniFFI's Swift glue reads a record field by field through `Data`, which
//! costs several microseconds an item: a listing of 10,000 notes took 70 ms to
//! read into Swift against 13 ms to list. A listing therefore crosses as one
//! buffer that the Swift package reads in one pass (`PackedRows.swift` in
//! withmarfa/marfa-swift), and each `Item` in it reads as the record would.
//!
//! The layout, with every integer little-endian:
//!
//! - The buffer: a `u32` count, then that many items.
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
//!   values, 7 an object.
//! - An object: a `u32` count, then that many pairs of a text key and a value.

use crate::{Item, ItemState, JsonObject, JsonValue, Tier};

pub(crate) fn pack(items: &[Item]) -> Vec<u8> {
    let mut packer = Packer(Vec::with_capacity(items.len() * 256));
    packer.count(items.len());
    for item in items {
        packer.item(item);
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

    fn item(&mut self, item: &Item) {
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
        self.optional_text(item.title.as_deref());
        self.optional_text(item.body.as_deref());
        self.optional_text(item.unreadable_properties.as_deref());
    }

    fn object(&mut self, object: &JsonObject) {
        self.count(object.members.len());
        for member in &object.members {
            self.text(&member.key);
            self.value(&member.value);
        }
    }

    fn value(&mut self, value: &JsonValue) {
        match value {
            JsonValue::Null => self.byte(0),
            JsonValue::Bool(false) => self.byte(1),
            JsonValue::Bool(true) => self.byte(2),
            JsonValue::Integer(integer) => {
                self.byte(3);
                self.i64(*integer);
            }
            JsonValue::Number(number) => {
                self.byte(4);
                self.f64(*number);
            }
            JsonValue::String(text) => {
                self.byte(5);
                self.text(text);
            }
            JsonValue::Array(values) => {
                self.byte(6);
                self.count(values.len());
                for value in values {
                    self.value(value);
                }
            }
            JsonValue::Object(object) => {
                self.byte(7);
                self.object(object);
            }
        }
    }
}

/// Reads what `pack` wrote, for the binding's own tests.
#[cfg(test)]
pub(crate) fn unpack(bytes: &[u8]) -> Vec<Item> {
    let mut reader = Reader(bytes);
    let count = reader.count();
    let items = (0..count).map(|_| reader.item()).collect();
    assert!(reader.0.is_empty(), "bytes left after the last item");
    items
}

#[cfg(test)]
struct Reader<'a>(&'a [u8]);

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

    fn item(&mut self) -> Item {
        Item {
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

    fn object(&mut self) -> JsonObject {
        JsonObject {
            members: (0..self.count())
                .map(|_| crate::JsonMember {
                    key: self.text(),
                    value: self.value(),
                })
                .collect(),
        }
    }

    fn value(&mut self) -> JsonValue {
        match self.byte() {
            0 => JsonValue::Null,
            1 => JsonValue::Bool(false),
            2 => JsonValue::Bool(true),
            3 => JsonValue::Integer(self.i64()),
            4 => JsonValue::Number(self.f64()),
            5 => JsonValue::String(self.text()),
            6 => JsonValue::Array((0..self.count()).map(|_| self.value()).collect()),
            7 => JsonValue::Object(self.object()),
            other => panic!("a value marked {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::JsonMember;

    fn member(key: &str, value: JsonValue) -> JsonMember {
        JsonMember {
            key: key.into(),
            value,
        }
    }

    fn every_field() -> Item {
        Item {
            id: "a".into(),
            r#type: "core.note".into(),
            properties: JsonObject {
                members: vec![
                    member("null", JsonValue::Null),
                    member("no", JsonValue::Bool(false)),
                    member("yes", JsonValue::Bool(true)),
                    member("integer", JsonValue::Integer(i64::MIN)),
                    member("number", JsonValue::Number(-0.5)),
                    member("text", JsonValue::String("é ✓ \u{0}".into())),
                    member(
                        "array",
                        JsonValue::Array(vec![JsonValue::Integer(1), JsonValue::Array(vec![])]),
                    ),
                    member(
                        "object",
                        JsonValue::Object(JsonObject {
                            members: vec![member("", JsonValue::Null)],
                        }),
                    ),
                ],
            },
            state: ItemState::Revoked,
            tier: Some(Tier::Feed),
            version: i64::MAX,
            schema_version: 2,
            source: "device".into(),
            source_id: Some("source".into()),
            occurred_at: "2026-01-01T00:00:00Z".into(),
            created_at: "2026-01-02T00:00:00Z".into(),
            updated_at: "2026-01-03T00:00:00Z".into(),
            tags: vec!["x".into(), "".into()],
            capture_latitude: Some(51.5),
            capture_longitude: Some(-0.12),
            title: Some("Title".into()),
            body: Some(String::new()),
            unreadable_properties: Some("why".into()),
        }
    }

    fn no_options() -> Item {
        Item {
            properties: JsonObject { members: vec![] },
            state: ItemState::Active,
            tier: None,
            source_id: None,
            tags: vec![],
            capture_latitude: None,
            capture_longitude: None,
            title: None,
            body: None,
            unreadable_properties: None,
            ..every_field()
        }
    }

    #[test]
    fn every_field_and_value_reads_back_as_it_was_packed() {
        let archived = Item {
            state: ItemState::Archived,
            tier: Some(Tier::Library),
            ..no_options()
        };
        let trashed = Item {
            state: ItemState::Trashed,
            ..no_options()
        };
        let items = vec![every_field(), no_options(), archived, trashed];
        assert_eq!(unpack(&pack(&items)), items);
        assert_eq!(unpack(&pack(&[])), vec![]);
    }

    #[test]
    fn the_layout_is_the_one_the_swift_package_reads() {
        let item = Item {
            id: "id".into(),
            properties: JsonObject {
                members: vec![member("k", JsonValue::Integer(1))],
            },
            ..no_options()
        };
        let mut expected = vec![1, 0, 0, 0];
        expected.extend([2, 0, 0, 0, b'i', b'd']);
        expected.extend([9, 0, 0, 0]);
        expected.extend(b"core.note");
        expected.extend([1, 0, 0, 0, 1, 0, 0, 0, b'k', 3, 1, 0, 0, 0, 0, 0, 0, 0]);
        expected.extend([0, 0]);
        expected.extend(i64::MAX.to_le_bytes());
        expected.extend(2i64.to_le_bytes());
        expected.extend([6, 0, 0, 0]);
        expected.extend(b"device");
        expected.push(0);
        for at in [
            "2026-01-01T00:00:00Z",
            "2026-01-02T00:00:00Z",
            "2026-01-03T00:00:00Z",
        ] {
            expected.extend([20, 0, 0, 0]);
            expected.extend(at.as_bytes());
        }
        expected.extend([0, 0, 0, 0]);
        expected.extend([0, 0, 0, 0, 0]);
        assert_eq!(pack(&[item]), expected);
    }
}
