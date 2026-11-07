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
pub fn is_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

/// Fixed notation holds up to 21 digits before the point and down to 6
/// zeros after it, as ECMAScript's `Number::toString` defines.
const LARGEST_FIXED_POINT: i32 = 21;
const SMALLEST_FIXED_POINT: i32 = -6;

/// The shortest digits that read back as `value`, as Ryū finds them (the even
/// digit where two are equally near), and the position of the decimal point
/// relative to the first digit.
fn digits_and_point(value: f64) -> (String, i32) {
    let mut buffer = ryu::Buffer::new();
    let text = buffer.format_finite(value);
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let joined = format!("{whole}{fraction}");
    let significant = joined.trim_start_matches('0');
    let skipped = (joined.len() - significant.len()) as i32;
    let point = whole.len() as i32 + exponent - skipped;
    (significant.trim_end_matches('0').to_string(), point)
}

/// JavaScript's `String()` of a finite number: fixed notation from 1e-6 up to
/// 1e21, exponent notation with an explicit sign outside it.
pub fn number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let (digits, point) = digits_and_point(value.abs());
    let count = digits.len() as i32;
    let body = if count <= point && point <= LARGEST_FIXED_POINT {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= LARGEST_FIXED_POINT {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{whole}.{fraction}")
    } else if SMALLEST_FIXED_POINT < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat(-point as usize))
    } else {
        let exponent = point - 1;
        let exponent_sign = if exponent < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{rest}e{exponent_sign}{}", exponent.abs())
    };
    format!("{sign}{body}")
}

/// `JSON.stringify` of a value: a condition on an array or object property
/// matches this text, so serde's `1e+20` would miss the server's digits.
pub fn json(value: &Value) -> String {
    let bytes = to_vec(value).expect("a JSON value serializes into memory");
    String::from_utf8(bytes).expect("serde_json writes UTF-8")
}

/// Writes anything serializable as JSON with every number printed as
/// [`number`] prints it. Only a value that refuses to serialize can fail.
pub fn to_vec(value: &impl Serialize) -> serde_json::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(256);
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut out, JsNumbers,
    ))?;
    Ok(out)
}

struct JsNumbers;

impl Formatter for JsNumbers {
    fn write_f32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        writer.write_all(number(f64::from(value)).as_bytes())
    }

    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(number(value).as_bytes())
    }
}

/// A JavaScript object's own key order, which every object the server
/// answers takes: keys that are array indices first, in numeric order, then
/// the rest in the order they were added.
pub fn object_order(object: &Map<String, Value>) -> Map<String, Value> {
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
            (0.1, "0.1"),
            (123456.789, "123456.789"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(number(value), rendered);
        }
    }

    #[test]
    #[allow(clippy::excessive_precision)]
    fn takes_the_even_digit_at_a_tie() {
        assert_eq!(number(3572143765320.15625), "3572143765320.1562");
    }

    #[test]
    fn writes_every_number_in_a_document_the_same_way() {
        let written = to_vec(&json!({ "a": 1.0, "b": [1e21, 2], "c": 18446744073709551615u64 }));
        assert_eq!(
            String::from_utf8(written.unwrap()).unwrap(),
            r#"{"a":1,"b":[1e+21,2],"c":18446744073709551615}"#
        );
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
