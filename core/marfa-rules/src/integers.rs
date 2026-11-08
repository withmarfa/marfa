//! A whole number is kept only when its digits are the ones the float it parses to prints as.
//! A number with a fraction or an exponent names a float, not digits, and is never judged.

use serde_json::{Map, Value};

use crate::error::{Code, FieldError, RuleError, field_code};
use crate::js;

/// Fewest digits a whole number can have and still be beyond a float's exact range, 2^53.
const MIN_DIGITS: usize = 16;

/// The digits the float that `source` rounds to prints as, where it is finite.
fn served_as(source: &str) -> Option<String> {
    source
        .parse::<f64>()
        .ok()
        .filter(|rounded| rounded.is_finite())
        .map(js::number)
}

/// Every safe integer is kept except `-0`, which is served as `0`.
pub fn kept(source: &str) -> bool {
    if source == "-0" {
        return false;
    }
    let digits = source.strip_prefix('-').unwrap_or(source);
    digits.len() < MIN_DIGITS || served_as(source).is_some_and(|served| served == source)
}

fn message(source: &str) -> String {
    let kept = served_as(source).map_or_else(String::new, |served| {
        format!(", which it serves as {served}")
    });
    format!(
        "Must be a whole number that Marfa serves back with the same digits, not {source}{kept}. Send it as a string."
    )
}

pub fn refusal_message(path: &[String], source: &str) -> String {
    format!("{}: {}", path.join("."), message(source))
}

fn refusal(path: &[String], source: &str) -> RuleError {
    RuleError::new(Code::InvalidProperties, refusal_message(path, source)).with_fields(vec![
        FieldError::new(path.join("."), field_code::INEXACT_INTEGER, message(source)),
    ])
}

/// A number the parse already rounded (beyond 64 bits) is not seen here; see [`refuse_inexact_integers`].
pub fn refuse_in_value(properties: &Map<String, Value>) -> Result<(), RuleError> {
    let mut stack: Vec<(Vec<String>, &Value)> = properties
        .iter()
        .rev()
        .map(|(name, value)| (vec![name.clone()], value))
        .collect();
    while let Some((path, value)) = stack.pop() {
        match value {
            Value::Number(number) if number.is_u64() || number.is_i64() => {
                let source = number.to_string();
                if !kept(&source) {
                    return Err(refusal(&path, &source));
                }
            }
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate().rev() {
                    let mut at = path.clone();
                    at.push(index.to_string());
                    stack.push((at, value));
                }
            }
            Value::Object(members) => {
                for (name, value) in members.iter().rev() {
                    let mut at = path.clone();
                    at.push(name.clone());
                    stack.push((at, value));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Reads `text` as written, since a number beyond 64 bits is already a float once parsed. Text that is not JSON is left to the caller's parse.
pub fn refuse_inexact_integers(text: &str) -> Result<(), RuleError> {
    match inexact_integers(text, None, true).into_iter().next() {
        Some((path, source)) => Err(refusal(&path, &source)),
        None => Ok(()),
    }
}

/// A path is named from inside the bag; `bag` of `None` covers the whole object.
pub fn refuse_inexact_integers_in(text: &str, bag: Option<&str>) -> Result<(), RuleError> {
    let found = inexact_integers(text, bag, false);
    if found.is_empty() {
        return Ok(());
    }
    Err(inexact_refusal(&found))
}

/// A path is named from inside the bag.
pub fn inexact_entry(text: &str, list: &str, bag: &str) -> Option<(usize, RuleError)> {
    inexact_integers(text, None, false)
        .into_iter()
        .find_map(|(path, source)| match path.as_slice() {
            [named, index, member, inside @ ..]
                if named == list && member == bag && !inside.is_empty() =>
            {
                let index = index.parse().ok()?;
                Some((index, inexact_refusal(&[(inside.to_vec(), source)])))
            }
            _ => None,
        })
}

fn inexact_refusal(found: &[(Vec<String>, String)]) -> RuleError {
    let fields: Vec<FieldError> = found
        .iter()
        .map(|(path, source)| {
            FieldError::new(path.join("."), field_code::INEXACT_INTEGER, message(source))
        })
        .collect();
    let listed: Vec<String> = found
        .iter()
        .map(|(path, source)| refusal_message(path, source))
        .collect();
    RuleError::new(
        Code::InvalidProperties,
        format!("Invalid properties: {}", listed.join("; ")),
    )
    .with_fields(fields)
}

fn inexact_integers(text: &str, bag: Option<&str>, first: bool) -> Vec<(Vec<String>, String)> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    if !bytes
        .windows(MIN_DIGITS)
        .any(|window| window.iter().all(u8::is_ascii_digit))
        && !bytes.windows(2).any(|window| window == b"-0")
    {
        return found;
    }
    let mut frames: Vec<(bool, String)> = Vec::new();
    let mut expecting_key = false;
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'{' => {
                frames.push((true, String::new()));
                expecting_key = true;
            }
            b'[' => {
                frames.push((false, "0".into()));
                expecting_key = false;
            }
            b'}' | b']' => {
                frames.pop();
                expecting_key = false;
            }
            b',' => match frames.last_mut() {
                Some((true, _)) => expecting_key = true,
                Some((false, index)) => {
                    *index = index.parse::<usize>().map_or(0, |n| n + 1).to_string();
                }
                None => {}
            },
            b':' => expecting_key = false,
            b'"' => {
                let mut end = at + 1;
                while end < bytes.len() && bytes[end] != b'"' {
                    end += if bytes[end] == b'\\' { 2 } else { 1 };
                }
                if expecting_key && let Some((true, name)) = frames.last_mut() {
                    *name = serde_json::from_str(text.get(at..=end).unwrap_or("\"\""))
                        .unwrap_or_default();
                }
                at = end;
            }
            b'-' | b'0'..=b'9' => {
                let end = bytes[at..]
                    .iter()
                    .position(|b| !matches!(b, b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'))
                    .map_or(bytes.len(), |length| at + length);
                let token = text.get(at..end).unwrap_or("");
                let whole = token.strip_prefix('-').unwrap_or(token);
                if !whole.is_empty() && whole.bytes().all(|b| b.is_ascii_digit()) && !kept(token) {
                    let mut path = frames.iter().map(|(_, name)| name.clone());
                    let inside: Option<Vec<String>> = match bag {
                        None => Some(path.collect()),
                        Some(bag) => (frames.len() > 1 && path.next().as_deref() == Some(bag))
                            .then(|| path.collect()),
                    };
                    if let Some(inside) = inside {
                        found.push((inside, token.to_string()));
                        if first {
                            return found;
                        }
                    }
                }
                at = end - 1;
            }
            _ => {}
        }
        at += 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_the_entry_and_the_path_inside_its_properties() {
        let text = r#"{"items":[{"version":1,"properties":{"a":1}},
            {"tag":9007199254740993,"properties":{"a":{"b":[9007199254740993]}}}]}"#;

        let (index, refusal) = inexact_entry(text, "items", "properties").expect("refused");

        assert_eq!(index, 1);
        assert_eq!(refusal.fields[0].path, "a.b.0");
    }

    #[test]
    fn a_whole_number_is_kept_when_its_digits_are_the_ones_javascript_prints() {
        for source in [
            "0",
            "-1",
            "9007199254740991",
            "-9007199254740991",
            "9007199254740992",
            "10000000000000000",
            "1152921504606847000",
            "-1152921504606847000",
            "9223372036854776000",
            "18446744073709552000",
            "100000000000000000000",
            "999999999999999900000",
        ] {
            assert!(kept(source), "{source}");
        }
    }

    #[test]
    fn a_whole_number_is_refused_when_its_digits_are_not_the_ones_javascript_prints() {
        for source in [
            "9007199254740993",
            "-9007199254740993",
            "1152921504606846976",
            "-1152921504606846976",
            "9223372036854775808",
            "18446744073709551615",
            "1500000000000000001",
            "9223372036854775807",
            "-9223372036854775808123",
            "999999999999999868928",
            "1000000000000000000000",
            "1000000000000000000001",
            "-0",
        ] {
            assert!(!kept(source), "{source}");
        }
        assert!(!kept(&"9".repeat(400)));
    }

    #[test]
    fn a_bag_is_judged_alone_and_each_path_is_named_from_inside_it() {
        let text = r#"{"version": 9007199254740993, "properties": {"a": [1, 1152921504606846976], "b": -0}, "capture_latitude": -0}"#;
        let refused = refuse_inexact_integers_in(text, Some("properties")).unwrap_err();
        let paths: Vec<&str> = refused.fields.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.1", "b"]);
        assert!(
            refuse_inexact_integers_in(r#"{"version": -0, "properties": {}}"#, Some("properties"))
                .is_ok()
        );
        assert!(refuse_inexact_integers_in(r#"{"a": -0}"#, None).is_err());
    }

    #[test]
    fn a_refusal_names_the_digits_a_float_keeps() {
        for (source, kept_as) in [
            ("1152921504606846976", Some("1152921504606847000")),
            ("-9007199254740993", Some("-9007199254740992")),
            ("1000000000000000000000", Some("1e+21")),
            ("-0", Some("0")),
            (
                "123456789012345678901234567890",
                Some("1.2345678901234568e+29"),
            ),
            (&"9".repeat(400), None),
        ] {
            let expected = match kept_as {
                Some(kept_as) => format!(
                    "Must be a whole number that Marfa serves back with the same digits, not {source}, which it serves as {kept_as}. Send it as a string."
                ),
                None => format!(
                    "Must be a whole number that Marfa serves back with the same digits, not {source}. Send it as a string."
                ),
            };
            assert_eq!(message(source), expected);
        }
    }

    #[test]
    fn a_value_names_the_property_that_holds_the_number() {
        let properties = json!({
            "ok": 9_007_199_254_740_991_i64,
            "list": [1, { "deep": -9_007_199_254_740_993_i64 }],
        });
        let Err(RuleError {
            code,
            message,
            fields,
        }) = refuse_in_value(properties.as_object().unwrap())
        else {
            panic!("expected a refusal");
        };
        assert_eq!(code, Code::InvalidProperties);
        assert_eq!(
            fields,
            [FieldError::new(
                "list.1.deep",
                field_code::INEXACT_INTEGER,
                "Must be a whole number that Marfa serves back with the same digits, not -9007199254740993, which it serves as -9007199254740992. Send it as a string."
            )]
        );
        assert_eq!(
            message,
            "list.1.deep: Must be a whole number that Marfa serves back with the same digits, not -9007199254740993, which it serves as -9007199254740992. Send it as a string."
        );
    }

    #[test]
    fn a_value_leaves_fractions_and_kept_numbers_alone() {
        let properties = json!({
            "a": 1.5, "b": 1e300, "c": 1_152_921_504_606_847_000_u64, "d": [1.5e19],
        });
        assert!(refuse_in_value(properties.as_object().unwrap()).is_ok());
    }

    #[test]
    fn text_names_where_the_number_sits() {
        let text =
            r#"{"ok": 1, "list": [1, {"deep": -9007199254740993}], "id64": 1500000000000000001}"#;
        let Err(RuleError { message, .. }) = refuse_inexact_integers(text) else {
            panic!("expected a refusal");
        };
        assert_eq!(
            message,
            "list.1.deep: Must be a whole number that Marfa serves back with the same digits, not -9007199254740993, which it serves as -9007199254740992. Send it as a string."
        );
    }

    #[test]
    fn text_reads_a_number_beyond_64_bits_as_written() {
        assert!(refuse_inexact_integers(r#"{"max": 99999999999999999999999}"#).is_err());
    }

    #[test]
    fn text_refuses_a_negative_zero_and_names_it() {
        for (text, member) in [
            (r#"{"a": -0}"#, "a"),
            (r#"{"a": [1, {"b": -0}]}"#, "a.1.b"),
            (r#"{ "a" : -0 , "b": 0}"#, "a"),
        ] {
            let Err(RuleError { message, .. }) = refuse_inexact_integers(text) else {
                panic!("expected a refusal of {text}");
            };
            assert_eq!(
                message,
                format!(
                    "{member}: Must be a whole number that Marfa serves back with the same digits, not -0, which it serves as 0. Send it as a string."
                ),
                "{text}"
            );
        }
    }

    #[test]
    fn text_leaves_a_zero_that_is_not_a_negative_whole_number_alone() {
        for text in [
            r#"{"a": 0, "b": -1, "c": 0.0}"#,
            r#"{"a": -0.0, "b": -0e0, "c": -0E5, "d": 1e-0}"#,
            r#"{"a": "-0", "b": "2026-01-01"}"#,
            r#"{"-0": 1}"#,
        ] {
            assert!(refuse_inexact_integers(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn text_leaves_strings_fractions_and_exponents_alone() {
        for text in [
            r#"{"a": "1500000000000000001"}"#,
            r#"{"a": 1500000000000000001.5, "b": 15000000000000000010e0, "c": 2E20}"#,
            r#"{"a": "he said \"1500000000000000001\"", "b": 1152921504606847000}"#,
            r#"{"a": 9007199254740991}"#,
        ] {
            assert!(refuse_inexact_integers(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn text_names_a_member_whose_name_needs_unescaping() {
        let Err(RuleError { message, .. }) =
            refuse_inexact_integers(r#"{"a\"b": 1500000000000000001}"#)
        else {
            panic!("expected a refusal");
        };
        assert!(message.starts_with("a\"b: "), "{message}");
    }
}
