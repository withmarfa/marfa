//! Marfa holds a number as a 64-bit float, so a whole number written with more
//! digits than a float keeps would come back as a different number. One is
//! kept as written when its digits are the float's exact value, or the
//! shortest digits that name that float, which is how the server writes every
//! whole number it serves. A number with a fraction or an exponent names a
//! float, not digits, and is never judged.

use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::js;

/// Fewest digits a whole number can have and still be beyond a float's exact
/// range, 2^53.
const MIN_DIGITS: usize = 16;

/// Whether the whole number written as `source` (optional minus, then digits)
/// is kept as written by a float.
pub(crate) fn kept(source: &str) -> bool {
    let digits = source.strip_prefix('-').unwrap_or(source);
    if digits.len() < MIN_DIGITS {
        return true;
    }
    let Ok(rounded) = source.parse::<f64>() else {
        return false;
    };
    rounded.is_finite() && (js::number(rounded) == source || format!("{rounded:.0}") == source)
}

/// What a write is told of a whole number that is not kept as written.
fn message(source: &str) -> String {
    format!(
        "Must be a whole number that a 64-bit float holds exactly, not {source}. Send it as a string."
    )
}

fn refusal(path: &[String], source: &str) -> CoreError {
    CoreError::Validation {
        code: "invalid_properties".into(),
        message: format!("{}: {}", path.join("."), message(source)),
    }
}

/// Refuses the first whole number in the properties that a float would
/// change, at any depth. A number the parse already rounded (one beyond 64
/// bits, from text) cannot be told here; the text is read by
/// [`refuse_inexact_integers`].
pub(crate) fn refuse_in_value(properties: &Map<String, Value>) -> Result<(), CoreError> {
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

/// Refuses the first whole number in `text`, a JSON object of properties,
/// that a float would change, read as written: a number beyond 64 bits is
/// already a float once parsed. Text that is not JSON is left to the caller's
/// own parse.
pub fn refuse_inexact_integers(text: &str) -> Result<(), CoreError> {
    if !text
        .as_bytes()
        .windows(MIN_DIGITS)
        .any(|window| window.iter().all(u8::is_ascii_digit))
    {
        return Ok(());
    }
    // One frame per open container: an object's current member name, or an
    // array's current index.
    let mut frames: Vec<(bool, String)> = Vec::new();
    let mut expecting_key = false;
    let bytes = text.as_bytes();
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
                let token = &text[at..end];
                let whole = token.strip_prefix('-').unwrap_or(token);
                if !whole.is_empty() && whole.bytes().all(|b| b.is_ascii_digit()) && !kept(token) {
                    let path: Vec<String> = frames.iter().map(|(_, name)| name.clone()).collect();
                    return Err(refusal(&path, token));
                }
                at = end - 1;
            }
            _ => {}
        }
        at += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_whole_number_is_kept_when_a_float_holds_it_as_written() {
        for source in [
            "0",
            "-0",
            "9007199254740991",
            "-9007199254740991",
            "9007199254740992",
            "1152921504606846976",
            "1152921504606847000",
            "9223372036854775808",
            "9223372036854776000",
            "1000000000000000000000",
            "-1152921504606846976",
        ] {
            assert!(kept(source), "{source}");
        }
    }

    #[test]
    fn a_whole_number_is_refused_when_a_float_would_change_it() {
        for source in [
            "9007199254740993",
            "-9007199254740993",
            "1500000000000000001",
            "9223372036854775807",
            "-9223372036854775808123",
            "1000000000000000000001",
        ] {
            assert!(!kept(source), "{source}");
        }
        assert!(!kept(&"9".repeat(400)));
    }

    #[test]
    fn a_value_names_the_property_that_holds_the_number() {
        let properties = json!({
            "ok": 9_007_199_254_740_991_i64,
            "list": [1, { "deep": -9_007_199_254_740_993_i64 }],
        });
        let Err(CoreError::Validation { code, message }) =
            refuse_in_value(properties.as_object().unwrap())
        else {
            panic!("expected a refusal");
        };
        assert_eq!(code, "invalid_properties");
        assert_eq!(
            message,
            "list.1.deep: Must be a whole number that a 64-bit float holds exactly, not -9007199254740993. Send it as a string."
        );
    }

    #[test]
    fn a_value_leaves_fractions_and_kept_numbers_alone() {
        let properties = json!({
            "a": 1.5, "b": 1e300, "c": 1_152_921_504_606_846_976_u64, "d": [1.5e19],
        });
        assert!(refuse_in_value(properties.as_object().unwrap()).is_ok());
    }

    #[test]
    fn text_names_where_the_number_sits() {
        let text =
            r#"{"ok": 1, "list": [1, {"deep": -9007199254740993}], "id64": 1500000000000000001}"#;
        let Err(CoreError::Validation { message, .. }) = refuse_inexact_integers(text) else {
            panic!("expected a refusal");
        };
        assert_eq!(
            message,
            "list.1.deep: Must be a whole number that a 64-bit float holds exactly, not -9007199254740993. Send it as a string."
        );
    }

    #[test]
    fn text_reads_a_number_beyond_64_bits_as_written() {
        assert!(refuse_inexact_integers(r#"{"max": 99999999999999999999999}"#).is_err());
    }

    #[test]
    fn text_leaves_strings_fractions_and_exponents_alone() {
        for text in [
            r#"{"a": "1500000000000000001"}"#,
            r#"{"a": 1500000000000000001.5, "b": 15000000000000000010e0, "c": 2E20}"#,
            r#"{"a": "he said \"1500000000000000001\"", "b": 1152921504606846976}"#,
            r#"{"a": 9007199254740991}"#,
        ] {
            assert!(refuse_inexact_integers(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn text_names_a_member_whose_name_needs_unescaping() {
        let Err(CoreError::Validation { message, .. }) =
            refuse_inexact_integers(r#"{"a\"b": 1500000000000000001}"#)
        else {
            panic!("expected a refusal");
        };
        assert!(message.starts_with("a\"b: "), "{message}");
    }
}
