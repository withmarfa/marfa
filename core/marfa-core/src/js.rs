//! Text and numbers read and written as JavaScript does, because the server
//! is JavaScript and its verdicts and stored text follow.

use std::io;

use serde::Serialize;
use serde_json::ser::Formatter;
use serde_json::{Map, Value};

/// A character JavaScript's `\s` matches and `String.prototype.trim` strips,
/// which is where the server ends an edge reference's word and where it finds
/// a tag blank. It is not Unicode's White_Space: that holds U+0085 and not
/// U+FEFF.
pub(crate) fn is_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

/// JavaScript's `String()` of a number: fixed notation from 1e-6 up to 1e21,
/// exponent notation with an explicit sign outside it.
pub(crate) fn number(number: f64) -> String {
    let magnitude = number.abs();
    if number == 0.0 {
        "0".into()
    } else if (1e-6..1e21).contains(&magnitude) {
        number.to_string()
    } else {
        let rendered = format!("{number:e}");
        match rendered.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => rendered,
        }
    }
}

/// `JSON.stringify` of a value: a condition on an array or object property
/// matches this text, so serde's `1e+20` would miss the server's digits.
pub(crate) fn json(value: &Value) -> String {
    let mut out = Vec::new();
    value
        .serialize(&mut serde_json::Serializer::with_formatter(
            &mut out, JsNumbers,
        ))
        .expect("a JSON value serializes into memory");
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

struct JsNumbers;

impl Formatter for JsNumbers {
    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(number(value).as_bytes())
    }
}

/// A JavaScript object's own key order, which every object the server
/// answers takes: keys that are array indices first, in numeric order, then
/// the rest in the order they were added.
pub(crate) fn object_order(object: &Map<String, Value>) -> Map<String, Value> {
    let mut indices: Vec<(u32, &String, &Value)> = object
        .iter()
        .filter_map(|(key, value)| array_index(key).map(|index| (index, key, value)))
        .collect();
    if indices.is_empty() {
        return object.clone();
    }
    indices.sort_by_key(|(index, _, _)| *index);
    let mut ordered: Map<String, Value> = indices
        .into_iter()
        .map(|(_, key, value)| (key.clone(), value.clone()))
        .collect();
    for (key, value) in object {
        if array_index(key).is_none() {
            ordered.insert(key.clone(), value.clone());
        }
    }
    ordered
}

/// An array index as ECMAScript defines one: the canonical decimal of an
/// integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let index: u32 = key.parse().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_a_number_as_javascript_does() {
        for (value, rendered) in [
            (5.0, "5"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (0.000001, "0.000001"),
            (0.0000015, "0.0000015"),
            (1.5e-7, "1.5e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (-1.25e22, "-1.25e+22"),
        ] {
            assert_eq!(number(value), rendered);
        }
    }

    #[test]
    fn writes_a_float_inside_a_container_as_json_stringify_does() {
        let value: Value = serde_json::from_str(
            r#"{"list":[100000000000000000000,0.0000015,1e+21,12,-3,1.5],"n":{"m":100000000000000000000}}"#,
        )
        .unwrap();
        assert_eq!(
            value.to_string(),
            r#"{"list":[1e+20,1.5e-6,1e+21,12,-3,1.5],"n":{"m":1e+20}}"#
        );
        assert_eq!(
            json(&value),
            r#"{"list":[100000000000000000000,0.0000015,1e+21,12,-3,1.5],"n":{"m":100000000000000000000}}"#
        );
        assert_eq!(json(&json!("a\"b")), r#""a\"b""#);
    }

    #[test]
    fn an_object_holds_array_index_names_first_as_javascript_does() {
        // `JSON.stringify(JSON.parse(text))` of this text in Node answers
        // `2, 10, 4294967294, zz, body, 01, -1, 4294967295, 1.5`.
        let text =
            r#"{"zz":1,"body":2,"10":3,"2":4,"01":5,"-1":6,"4294967295":7,"4294967294":8,"1.5":9}"#;
        let object: Map<String, Value> = serde_json::from_str(text).unwrap();
        let ordered = object_order(&object);
        let keys: Vec<&str> = ordered.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "2",
                "10",
                "4294967294",
                "zz",
                "body",
                "01",
                "-1",
                "4294967295",
                "1.5"
            ]
        );
        let plain: Map<String, Value> = serde_json::from_str(r#"{"b":1,"a":2}"#).unwrap();
        assert_eq!(
            object_order(&plain).keys().collect::<Vec<_>>(),
            ["b", "a"],
            "an object with no array index names was reordered"
        );
    }
}
