//! JSON values as they cross the binding: an enum, so a property arrives as
//! the value it is and never as text to parse again.

use serde_json::{Map, Number, Value};

use crate::MarfaError;

/// The deepest nesting a value may have to cross into the core, the limit
/// `serde_json` puts on a document it reads.
const NESTING_LIMIT: usize = 128;

/// One JSON value.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum JsonValue {
    Null,
    Bool(bool),
    /// A number with no fraction or exponent that fits 64 bits.
    Integer(i64),
    /// Any other number. An integer too large for `Integer` arrives here,
    /// rounded to the nearest `f64`; a number sent to the core must be
    /// finite.
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(JsonObject),
}

/// A JSON object that keeps its keys in order.
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct JsonObject {
    /// In order; a key appears once, as the bytes of its UTF-8.
    #[uniffi(default = [])]
    pub members: Vec<JsonMember>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct JsonMember {
    pub key: String,
    pub value: JsonValue,
}

impl From<Value> for JsonValue {
    fn from(value: Value) -> Self {
        match value {
            Value::Null => JsonValue::Null,
            Value::Bool(flag) => JsonValue::Bool(flag),
            Value::Number(number) => match number.as_i64() {
                Some(integer) => JsonValue::Integer(integer),
                // Without `arbitrary_precision`, every number has an `f64`.
                None => JsonValue::Number(number.as_f64().unwrap_or(f64::NAN)),
            },
            Value::String(text) => JsonValue::String(text),
            Value::Array(items) => JsonValue::Array(items.into_iter().map(Into::into).collect()),
            Value::Object(map) => JsonValue::Object(map.into()),
        }
    }
}

impl From<Map<String, Value>> for JsonObject {
    fn from(map: Map<String, Value>) -> Self {
        JsonObject {
            members: map
                .into_iter()
                .map(|(key, value)| JsonMember {
                    key,
                    value: value.into(),
                })
                .collect(),
        }
    }
}

impl JsonValue {
    /// Refused `Invalid` for a number that is not finite and for nesting
    /// deeper than the core reads.
    pub fn into_value(self) -> Result<Value, MarfaError> {
        self.value_at(0)
    }

    fn value_at(self, depth: usize) -> Result<Value, MarfaError> {
        Ok(match self {
            JsonValue::Null => Value::Null,
            JsonValue::Bool(flag) => Value::Bool(flag),
            JsonValue::Integer(integer) => Value::Number(integer.into()),
            JsonValue::Number(number) => {
                Value::Number(Number::from_f64(number).ok_or_else(|| MarfaError::Invalid {
                    message: "a number in the JSON is not finite".into(),
                })?)
            }
            JsonValue::String(text) => Value::String(text),
            JsonValue::Array(items) => {
                nested(depth)?;
                Value::Array(
                    items
                        .into_iter()
                        .map(|item| item.value_at(depth + 1))
                        .collect::<Result<_, _>>()?,
                )
            }
            JsonValue::Object(object) => Value::Object(object.map_at(depth)?),
        })
    }
}

impl JsonObject {
    /// Refused `Invalid` for a key that repeats, as the bytes of its UTF-8,
    /// and for what `JsonValue::into_value` refuses.
    pub fn into_map(self) -> Result<Map<String, Value>, MarfaError> {
        self.map_at(0)
    }

    fn map_at(self, depth: usize) -> Result<Map<String, Value>, MarfaError> {
        nested(depth)?;
        let mut map = Map::with_capacity(self.members.len());
        for JsonMember { key, value } in self.members {
            let value = value.value_at(depth + 1)?;
            if map.insert(key.clone(), value).is_some() {
                return Err(MarfaError::Invalid {
                    message: format!("the key {key:?} appears twice in one JSON object"),
                });
            }
        }
        Ok(map)
    }
}

fn nested(depth: usize) -> Result<(), MarfaError> {
    if depth >= NESTING_LIMIT {
        return Err(MarfaError::Invalid {
            message: format!("JSON nested deeper than {NESTING_LIMIT}"),
        });
    }
    Ok(())
}

/// A body the core kept as text, as the value it holds. A body that is not
/// JSON, such as a gateway's page, stands as its text, a string.
pub fn answer(text: &str) -> JsonValue {
    serde_json::from_str::<Value>(text).map_or_else(|_| JsonValue::String(text.into()), Into::into)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn crossed(value: Value) -> Value {
        JsonValue::from(value).into_value().unwrap()
    }

    #[test]
    fn every_kind_of_value_comes_back_as_it_went() {
        for value in [
            json!(null),
            json!(true),
            json!(false),
            json!(0),
            json!(-7),
            json!(9_007_199_254_740_993_i64),
            json!(i64::MIN),
            json!(i64::MAX),
            json!(1.5),
            json!(-0.25e-9),
            json!(1.0),
            json!(""),
            json!("caf\u{e9} \u{1F600} \u{0} \u{2028}"),
            json!([]),
            json!({}),
            json!([1, [2, [3, {"a": [null, "b"]}]]]),
            json!({"z": 1, "a": {"y": [true], "b": null}, "m": "x"}),
        ] {
            assert_eq!(crossed(value.clone()), value, "{value}");
        }
    }

    #[test]
    fn an_integer_beyond_two_to_the_fifty_third_is_kept_exact() {
        let big = json!(9_007_199_254_740_993_i64);
        assert_eq!(
            JsonValue::from(big.clone()),
            JsonValue::Integer(9_007_199_254_740_993)
        );
        assert_eq!(crossed(big.clone()).as_i64(), Some(9_007_199_254_740_993));
        assert_eq!(crossed(big).to_string(), "9007199254740993");
    }

    #[test]
    fn an_integer_beyond_sixty_four_bits_arrives_as_the_nearest_float() {
        let huge: Value = serde_json::from_str("18446744073709551615").unwrap();
        assert_eq!(
            JsonValue::from(huge),
            JsonValue::Number(18446744073709551615.0)
        );
    }

    #[test]
    fn a_float_that_is_whole_stays_a_float() {
        assert_eq!(JsonValue::from(json!(2.0)), JsonValue::Number(2.0));
        assert_eq!(crossed(json!(2.0)).to_string(), "2.0");
    }

    #[test]
    fn an_object_keeps_its_keys_in_order() {
        let object: Value = serde_json::from_str(r#"{"b":1,"a":2,"10":3,"2":4}"#).unwrap();
        let JsonValue::Object(crossed) = JsonValue::from(object) else {
            panic!("an object crossed as another kind");
        };
        let keys: Vec<&str> = crossed.members.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["b", "a", "10", "2"]);
    }

    #[test]
    fn a_number_that_is_not_finite_is_refused() {
        for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let refusal = JsonValue::Array(vec![JsonValue::Number(number)])
                .into_value()
                .unwrap_err();
            assert!(matches!(refusal, MarfaError::Invalid { .. }), "{number}");
        }
        assert!(JsonValue::Number(f64::MAX).into_value().is_ok());
    }

    #[test]
    fn a_key_that_repeats_is_refused_and_two_that_differ_only_in_normalization_are_two() {
        let member = |key: &str| JsonMember {
            key: key.into(),
            value: JsonValue::Null,
        };
        let refusal = JsonObject {
            members: vec![member("a"), member("b"), member("a")],
        }
        .into_map()
        .unwrap_err();
        assert!(matches!(refusal, MarfaError::Invalid { message } if message.contains("twice")));
        let composed = "\u{e9}";
        let decomposed = "e\u{301}";
        let map = JsonObject {
            members: vec![member(composed), member(decomposed)],
        }
        .into_map()
        .unwrap();
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn nesting_past_the_limit_is_refused_and_the_limit_itself_is_not() {
        let nest = |depth: usize| {
            (0..depth).fold(JsonValue::Null, |inner, _| JsonValue::Array(vec![inner]))
        };
        assert!(nest(NESTING_LIMIT).into_value().is_ok());
        assert!(matches!(
            nest(NESTING_LIMIT + 1).into_value(),
            Err(MarfaError::Invalid { .. })
        ));
        let in_object = (0..=NESTING_LIMIT).fold(JsonValue::Null, |inner, _| {
            JsonValue::Object(JsonObject {
                members: vec![JsonMember {
                    key: "k".into(),
                    value: inner,
                }],
            })
        });
        assert!(matches!(
            in_object.into_value(),
            Err(MarfaError::Invalid { .. })
        ));
    }

    #[test]
    fn an_answer_is_the_value_its_text_holds_or_the_text() {
        assert_eq!(
            answer(r#"{"error":{"code":"x"}}"#),
            JsonValue::from(json!({"error": {"code": "x"}}))
        );
        assert_eq!(
            answer("<html>502</html>"),
            JsonValue::String("<html>502</html>".into())
        );
        assert_eq!(answer(""), JsonValue::String(String::new()));
    }
}
