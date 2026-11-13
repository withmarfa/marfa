//! A page cursor: what it continues from, signed with what it continues, so
//! that a cursor from another query, another key or another hand is refused.

use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use rusqlite::types::Value;
use serde_json::{Value as Json, json};
use sha2::Sha256;

use crate::app::refusal::{Refusal, Result};

pub const SECRET_KEY: &str = "cursor_secret";

const TAG_BYTES: usize = 12;
const KEYED_BYTES: usize = 16;

#[derive(Clone)]
pub struct Secret(pub Vec<u8>);

impl Secret {
    fn whole_tag(&self, scope: &str, payload: &[u8]) -> Result<Vec<u8>> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| Refusal::internal("the cursor secret was refused"))?;
        mac.update(scope.as_bytes());
        mac.update(&[0]);
        mac.update(payload);
        Ok(mac.finalize().into_bytes().to_vec())
    }

    fn tag(&self, scope: &str, payload: &[u8]) -> Result<Vec<u8>> {
        let mut tag = self.whole_tag(scope, payload)?;
        tag.truncate(TAG_BYTES);
        Ok(tag)
    }

    /// The whole tag in hex, for a value that is compared and never opened.
    pub fn certify(&self, scope: &str, payload: &str) -> Result<String> {
        Ok(hex::encode(self.whole_tag(scope, payload.as_bytes())?))
    }

    /// The tag of a key a cursor stands in for, as short as the cursor's own.
    pub fn key_tag(&self, scope: &str, text: &str) -> Result<String> {
        Ok(hex::encode(self.tag(scope, text.as_bytes())?))
    }

    /// A stored id derives from this, so its length is its own and never the cursor tag's.
    pub fn keyed(&self, scope: &str, text: &str) -> Result<String> {
        let mut tag = self.whole_tag(scope, text.as_bytes())?;
        tag.truncate(KEYED_BYTES);
        Ok(hex::encode(tag))
    }

    pub fn issue(&self, scope: &str, payload: &Json) -> Result<String> {
        let payload = compact::encode(payload);
        let mut bytes = self.tag(scope, &payload)?;
        bytes.extend(payload);
        Ok(BASE64_URL_SAFE_NO_PAD.encode(bytes))
    }

    /// A place in a listing ordered by one text key, then by id.
    pub fn issue_at(&self, scope: &str, key: &str, id: &str) -> Result<String> {
        let position = Position {
            keys: vec![Value::Text(key.to_string())],
            id: id.to_string(),
        };
        self.issue(scope, &position.payload())
    }

    pub fn open_at(&self, scope: &str, cursor: &str) -> Result<(String, String)> {
        let position = Position::from_payload(&self.open(scope, cursor)?, 1)?;
        match position.keys.as_slice() {
            [Value::Text(key)] => Ok((key.clone(), position.id)),
            _ => Err(refused()),
        }
    }

    pub fn open(&self, scope: &str, cursor: &str) -> Result<Json> {
        let bytes = BASE64_URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| refused())?;
        if bytes.len() < TAG_BYTES {
            return Err(refused());
        }
        let (tag, payload) = bytes.split_at(TAG_BYTES);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| Refusal::internal("the cursor secret was refused"))?;
        mac.update(scope.as_bytes());
        mac.update(&[0]);
        mac.update(payload);
        mac.verify_truncated_left(tag).map_err(|_| refused())?;
        compact::decode(payload).ok_or_else(refused)
    }
}

pub fn refused() -> Refusal {
    Refusal::validation("The cursor does not belong to this listing.")
        .with_detail("field", "cursor")
}

#[derive(Clone, Debug)]
pub struct Position {
    pub keys: Vec<Value>,
    pub id: String,
}

impl Position {
    pub fn payload(&self) -> Json {
        let keys: Vec<Json> = self
            .keys
            .iter()
            .map(|key| match key {
                Value::Integer(number) => json!(number),
                Value::Real(number) => json!(number),
                Value::Text(text) => json!(text),
                Value::Null | Value::Blob(_) => Json::Null,
            })
            .collect();
        json!([keys, self.id])
    }

    pub fn from_payload(payload: &Json, width: usize) -> Result<Position> {
        let [keys, id] = payload.as_array().map(Vec::as_slice).unwrap_or_default() else {
            return Err(refused());
        };
        let keys = keys.as_array().ok_or_else(refused)?;
        if keys.len() != width {
            return Err(refused());
        }
        let keys = keys
            .iter()
            .map(|key| match key {
                Json::Null => Ok(Value::Null),
                Json::String(text) => Ok(Value::Text(text.clone())),
                Json::Number(number) => number
                    .as_i64()
                    .map(Value::Integer)
                    .or_else(|| number.as_f64().map(Value::Real))
                    .ok_or_else(refused),
                _ => Err(refused()),
            })
            .collect::<Result<_>>()?;
        let id = id.as_str().ok_or_else(refused)?.to_string();
        Ok(Position { keys, id })
    }
}

/// A payload as a kind byte and its value, a UUID held as its 16 bytes.
mod compact {
    use serde_json::{Map, Number, Value};
    use uuid::Uuid;

    const NULL: u8 = 0;
    const FALSE: u8 = 1;
    const TRUE: u8 = 2;
    const WHOLE: u8 = 3;
    const BELOW_ZERO: u8 = 4;
    const FRACTION: u8 = 5;
    const TEXT: u8 = 6;
    const LIST: u8 = 7;
    const OBJECT: u8 = 8;
    const UUID_V: u8 = 9;

    const DEEPEST: usize = 16;

    pub fn encode(value: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        write(value, &mut out);
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Value> {
        let mut rest = bytes;
        let value = read(&mut rest, 0)?;
        rest.is_empty().then_some(value)
    }

    fn varint(mut number: u64, out: &mut Vec<u8>) {
        while number >= 0x80 {
            out.push((number & 0x7f) as u8 | 0x80);
            number >>= 7;
        }
        out.push(number as u8);
    }

    fn text(text: &str, out: &mut Vec<u8>) {
        varint(text.len() as u64, out);
        out.extend_from_slice(text.as_bytes());
    }

    fn write(value: &Value, out: &mut Vec<u8>) {
        match value {
            Value::Null => out.push(NULL),
            Value::Bool(false) => out.push(FALSE),
            Value::Bool(true) => out.push(TRUE),
            Value::Number(number) => {
                if let Some(whole) = number.as_u64() {
                    out.push(WHOLE);
                    varint(whole, out);
                } else if let Some(below) = number.as_i64() {
                    out.push(BELOW_ZERO);
                    varint(below.unsigned_abs(), out);
                } else {
                    out.push(FRACTION);
                    out.extend_from_slice(&number.as_f64().unwrap_or_default().to_le_bytes());
                }
            }
            Value::String(word) => match Uuid::parse_str(word) {
                Ok(id) if id.hyphenated().to_string() == *word => {
                    out.push(UUID_V);
                    out.extend_from_slice(id.as_bytes());
                }
                _ => {
                    out.push(TEXT);
                    text(word, out);
                }
            },
            Value::Array(items) => {
                out.push(LIST);
                varint(items.len() as u64, out);
                for item in items {
                    write(item, out);
                }
            }
            Value::Object(fields) => {
                out.push(OBJECT);
                varint(fields.len() as u64, out);
                for (name, field) in fields {
                    text(name, out);
                    write(field, out);
                }
            }
        }
    }

    fn take<'a>(rest: &mut &'a [u8], count: usize) -> Option<&'a [u8]> {
        let (head, tail) = rest.split_at_checked(count)?;
        *rest = tail;
        Some(head)
    }

    fn number(rest: &mut &[u8]) -> Option<u64> {
        let mut number = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *take(rest, 1)?.first()?;
            number |= u64::from(byte & 0x7f).checked_shl(shift)?;
            if byte & 0x80 == 0 {
                return Some(number);
            }
        }
        None
    }

    fn word(rest: &mut &[u8]) -> Option<String> {
        let length = usize::try_from(number(rest)?).ok()?;
        String::from_utf8(take(rest, length)?.to_vec()).ok()
    }

    fn read(rest: &mut &[u8], depth: usize) -> Option<Value> {
        if depth > DEEPEST {
            return None;
        }
        let kind = *take(rest, 1)?.first()?;
        Some(match kind {
            NULL => Value::Null,
            FALSE => Value::Bool(false),
            TRUE => Value::Bool(true),
            WHOLE => Value::from(number(rest)?),
            BELOW_ZERO => Value::from(i64::try_from(-i128::from(number(rest)?)).ok()?),
            FRACTION => {
                let bytes: [u8; 8] = take(rest, 8)?.try_into().ok()?;
                Value::Number(Number::from_f64(f64::from_le_bytes(bytes))?)
            }
            TEXT => Value::String(word(rest)?),
            UUID_V => {
                let bytes: [u8; 16] = take(rest, 16)?.try_into().ok()?;
                Value::String(Uuid::from_bytes(bytes).hyphenated().to_string())
            }
            LIST => {
                let count = usize::try_from(number(rest)?).ok()?;
                let mut items = Vec::new();
                for _ in 0..count {
                    items.push(read(rest, depth + 1)?);
                }
                Value::Array(items)
            }
            OBJECT => {
                let count = usize::try_from(number(rest)?).ok()?;
                let mut fields = Map::new();
                for _ in 0..count {
                    let name = word(rest)?;
                    fields.insert(name, read(rest, depth + 1)?);
                }
                Value::Object(fields)
            }
            _ => return None,
        })
    }

    #[cfg(test)]
    mod tests {
        use serde_json::json;

        use super::*;

        #[test]
        fn every_kind_of_payload_comes_back_as_it_went() {
            for value in [
                json!(null),
                json!(true),
                json!(false),
                json!(0),
                json!(300),
                json!(u64::MAX),
                json!(-1),
                json!(i64::MIN),
                json!(1.5),
                json!(-2.25),
                json!(1.0),
                json!(""),
                json!("a text with é and \u{1F600}"),
                json!("01a1d26e-1532-70bc-9d15-1c2ae5645708"),
                json!("01A1D26E-1532-70BC-9D15-1C2AE5645708"),
                json!([[1, "x", null, 2.5], "01a1d26e-1532-70bc-9d15-1c2ae5645708"]),
                json!({"before": 12, "next": [{"deep": [1, 2]}]}),
            ] {
                let bytes = encode(&value);
                let back = decode(&bytes).unwrap_or_else(|| panic!("{value} did not decode"));
                assert_eq!(back, value);
                assert_eq!(
                    back.to_string(),
                    value.to_string(),
                    "the kind of number held"
                );
            }
        }

        #[test]
        fn a_uuid_takes_sixteen_bytes_and_not_thirty_six() {
            let id = "01a1d26e-1532-70bc-9d15-1c2ae5645708";
            assert_eq!(encode(&json!(id)).len(), 17);
            assert_eq!(encode(&json!(id.to_uppercase())).len(), 2 + 36);
        }

        #[test]
        fn bytes_that_are_not_a_payload_are_refused() {
            let good = encode(&json!(["abc", 7]));
            assert!(decode(&good).is_some());
            let mut trailing = good.clone();
            trailing.push(0);
            assert!(decode(&trailing).is_none(), "bytes left over");
            assert!(decode(&good[..good.len() - 1]).is_none(), "cut short");
            assert!(decode(&[]).is_none());
            assert!(decode(&[200]).is_none(), "no such kind");
            assert!(
                decode(&[TEXT, 5, b'a']).is_none(),
                "a text longer than what is left"
            );
            assert!(decode(&[TEXT, 1, 0xff]).is_none(), "not UTF-8");
            assert!(decode(&[WHOLE, 0x80]).is_none(), "a number that never ends");
            assert!(
                decode(&[
                    BELOW_ZERO, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01
                ])
                .is_none(),
                "below the smallest integer"
            );
            let mut deep = [LIST, 1].repeat(40);
            deep.push(NULL);
            assert!(decode(&deep).is_none(), "nested past the limit");
            let nan = [&[FRACTION][..], &f64::NAN.to_le_bytes()].concat();
            assert!(decode(&nan).is_none());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_keyed_id_is_the_first_sixteen_bytes_of_the_tag_whatever_a_cursor_keeps() {
        let secret = Secret(b"cursor-test-secret".to_vec());
        assert_eq!(
            secret.keyed("conflicted-copy", "claim-attempt-1").unwrap(),
            "de3062e502ffeef8a3c8c74dd80548a0"
        );
    }
}
