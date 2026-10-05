//! Text and numbers read and written as JavaScript does, because the server
//! is JavaScript and its verdicts and stored text follow.

use std::io;

use serde::Serialize;
use serde_json::Value;
use serde_json::ser::Formatter;

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
}
