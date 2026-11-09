//! How a number is written: the shortest decimal digits that read back as the same double, so a server and every device print one number alike.

use std::io;

use serde::Serialize;
use serde_json::ser::Formatter;
use serde_json::{Map, Value};

/// Fixed notation holds up to 21 digits before the point and down to 6 zeros after it; a number outside it is written with an exponent.
const LARGEST_FIXED_POINT: i32 = 21;
const SMALLEST_FIXED_POINT: i32 = -6;

/// The shortest digits that read back as `value` (the even digit at a tie), and the decimal point's position relative to the first digit.
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

/// The shortest digits that read back as `value`, the even last digit at a tie. Fixed notation from 0.000001 up to below 1e21; outside it the digits, a point after the first and an exponent with its sign, such as `1e+21` and `1.5e-7`. Negative zero is `0`.
pub fn text(value: f64) -> String {
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

/// A JSON value with every number written as [`text`] writes it, and every object's names in the order they were written.
pub fn json(value: &Value) -> String {
    render(value)
}

/// A JSON object, as [`json`] writes it.
pub fn object(object: &Map<String, Value>) -> String {
    render(object)
}

fn render(value: &impl Serialize) -> String {
    let bytes = to_vec(value).expect("a JSON value serializes into memory");
    String::from_utf8(bytes).expect("serde_json writes UTF-8")
}

/// Every number is written as [`text`] writes it. Only a value that refuses to serialize can fail.
pub fn to_vec(value: &impl Serialize) -> serde_json::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(256);
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut out, Digits,
    ))?;
    Ok(out)
}

struct Digits;

impl Formatter for Digits {
    fn write_f32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        writer.write_all(text(f64::from(value)).as_bytes())
    }

    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(text(value).as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn writes_the_shortest_digits_that_read_back_the_same() {
        for (value, written) in [
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
            assert_eq!(text(value), written);
            assert_eq!(written.parse::<f64>().unwrap().abs(), value.abs());
        }
    }

    #[test]
    #[allow(clippy::excessive_precision)]
    fn takes_the_even_digit_at_a_tie() {
        assert_eq!(text(3572143765320.15625), "3572143765320.1562");
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
    fn writes_a_number_inside_a_container_as_it_writes_one_alone() {
        let value: Value = serde_json::from_str(
            r#"{"list":[100000000000000000000,0.0000015,1e+21,12,-3,1.5],"n":{"m":100000000000000000000}}"#,
        )
        .unwrap();
        assert_eq!(
            json(&value),
            r#"{"list":[100000000000000000000,0.0000015,1e+21,12,-3,1.5],"n":{"m":100000000000000000000}}"#
        );
        assert_eq!(json(&json!("a\"b")), r#""a\"b""#);
    }

    #[test]
    fn keeps_the_names_of_an_object_in_the_order_they_were_written() {
        let text = r#"{"b":1,"1":2,"a":{"z":0,"10":1.0,"2":2},"01":3,"4294967295":4}"#;
        let parsed: Map<String, Value> = serde_json::from_str(text).unwrap();
        assert_eq!(
            object(&parsed),
            r#"{"b":1,"1":2,"a":{"z":0,"10":1,"2":2},"01":3,"4294967295":4}"#
        );
    }
}
