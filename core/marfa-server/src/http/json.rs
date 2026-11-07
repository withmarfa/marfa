//! The one JSON writer. It prints a number as ECMAScript's `Number::toString`
//! does, which is the number-exact form the contract answers in.

use std::io;

use serde::Serialize;
use serde_json::ser::Formatter;

const LARGEST_FIXED_POINT: i32 = 21;
const SMALLEST_FIXED_POINT: i32 = -6;

struct JsNumbers;

impl Formatter for JsNumbers {
    fn write_f32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        writer.write_all(number(f64::from(value)).as_bytes())
    }

    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(number(value).as_bytes())
    }
}

/// The shortest digits that read back as `value`, as Ryū finds them, and the
/// position of the decimal point relative to the first digit.
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

/// Writes a value as JSON. Only a value that refuses to serialize can fail.
pub fn to_vec(value: &impl Serialize) -> serde_json::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(256);
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut out, JsNumbers,
    ))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn prints_a_number_as_ecmascript_does() {
        for (value, printed) in [
            (5.0, "5"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (0.0000015, "0.0000015"),
            (1.5e-7, "1.5e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (-1.25e22, "-1.25e+22"),
            (123456.789, "123456.789"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(number(value), printed);
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
}
