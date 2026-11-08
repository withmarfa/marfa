//! A page cursor: what it continues from, signed with what it continues, so
//! that a cursor from another query, another key or another hand is refused.

use hmac::{Hmac, KeyInit, Mac};
use rusqlite::types::Value;
use serde_json::{Value as Json, json};
use sha2::Sha256;

use crate::app::refusal::{Refusal, Result};

pub const SECRET_KEY: &str = "cursor_secret";

const TAG_BYTES: usize = 16;

#[derive(Clone)]
pub struct Secret(pub Vec<u8>);

impl Secret {
    fn tag(&self, scope: &str, payload: &[u8]) -> Result<Vec<u8>> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| Refusal::internal("the cursor secret was refused"))?;
        mac.update(scope.as_bytes());
        mac.update(&[0]);
        mac.update(payload);
        let mut tag = mac.finalize().into_bytes().to_vec();
        tag.truncate(TAG_BYTES);
        Ok(tag)
    }

    pub fn keyed(&self, scope: &str, text: &str) -> Result<String> {
        Ok(hex::encode(self.tag(scope, text.as_bytes())?))
    }

    pub fn issue(&self, scope: &str, payload: &Json) -> Result<String> {
        let payload = payload.to_string().into_bytes();
        let tag = self.tag(scope, &payload)?;
        Ok(format!("{}{}", hex::encode(tag), hex::encode(payload)))
    }

    pub fn open(&self, scope: &str, cursor: &str) -> Result<Json> {
        let bytes = hex::decode(cursor).map_err(|_| refused())?;
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
        serde_json::from_slice(payload).map_err(|_| refused())
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
