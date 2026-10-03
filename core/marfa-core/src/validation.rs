use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::model::{THUMBNAIL_MAX_BYTES, Thumbnail};

pub(crate) fn properties(
    fields: &BTreeMap<&str, &Value>,
    properties: &Map<String, Value>,
    complete: bool,
) -> Result<(), CoreError> {
    let mut errors = Vec::new();
    for (name, definition) in fields {
        let required = definition.get("required").and_then(Value::as_bool) == Some(true);
        let Some(value) = properties.get(*name) else {
            if complete && required {
                errors.push(format!("{name}: Required field is missing"));
            }
            continue;
        };
        if value.is_null() && !required {
            continue;
        }
        let kind = definition
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CoreError::Decoding(format!("the held field {name} declares no type"))
            })?;
        if let Some(message) = field(kind, definition, value)? {
            errors.push(format!("{name}: {message}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CoreError::Validation {
            code: "invalid_properties".into(),
            message: errors.join("; "),
        })
    }
}

fn field(kind: &str, definition: &Value, value: &Value) -> Result<Option<String>, CoreError> {
    let expected = |kind| Some(format!("Expected {kind}"));
    let limit = |key, default| {
        definition
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(default)
    };
    let bounded = |text: &str| {
        let max = limit("maxLength", 100_000);
        if text.encode_utf16().count() as u64 > max {
            Some(format!("Must contain at most {max} UTF-16 code units"))
        } else if text.contains('\0') {
            Some("Must not contain a null byte (U+0000)".into())
        } else {
            None
        }
    };
    Ok(match kind {
        "string" => match value.as_str() { Some(text) => bounded(text), None => expected("string") },
        "enum" => match value.as_str() {
            None => expected("string"),
            Some(text) => match definition.get("enum_values").and_then(Value::as_array).filter(|values| !values.is_empty()) {
                Some(values) if !values.iter().any(|value| value.as_str() == Some(text)) => Some(format!("Must be one of {}", values.iter().map(Value::to_string).collect::<Vec<_>>().join(", "))),
                Some(_) => None,
                None => bounded(text),
            }
        },
        "number" => if value.as_f64().is_some_and(f64::is_finite) { None } else { expected("number") },
        "integer" => if value.as_f64().is_some_and(|number| number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0) { None } else { expected("safe integer") },
        "boolean" => if value.is_boolean() { None } else { expected("boolean") },
        "array" => match value.as_array() {
            None => expected("array"),
            Some(values) if values.len() as u64 > limit("maxItems", 10_000) => Some(format!("Must contain at most {} items", limit("maxItems", 10_000))),
            Some(_) => None,
        },
        "object" => if value.is_object() { None } else { expected("object") },
        "url" => if value.as_str().is_some_and(|text| url::Url::parse(text).is_ok()) { None } else { Some("Must be a valid URL".into()) },
        "email" => if value.as_str().is_some_and(email) { None } else { Some("Must be a valid email address".into()) },
        "date" => if value.as_str().is_some_and(date) { None } else { Some("Must be a calendar date (YYYY-MM-DD)".into()) },
        "datetime" => if value.as_str().is_some_and(|text| date(text) || datetime(text)) { None } else { Some("Must be a calendar date or ISO 8601 datetime with an offset".into()) },
        "thumbnail" => match value.as_str() {
            None => expected("thumbnail data URI"),
            Some(text) if text.len() > 40 + THUMBNAIL_MAX_BYTES.div_ceil(3) * 4 => Some(format!("Must decode to at most {THUMBNAIL_MAX_BYTES} bytes")),
            Some(text) => Thumbnail::from_data_uri(text).err().map(|_| "Must be a PNG, JPEG or WebP data URI with canonical base64, its image signature, and at most 16384 decoded bytes".into()),
        },
        _ => return Err(CoreError::Decoding(format!("the held field declares unsupported type {kind}"))),
    })
}

// The server uses Zod's practical email pattern, rather than RFC 5322 or
// HTML's broader email shape. Keep its accepted neighbours here too.
fn email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    let local_end = |byte: u8| byte.is_ascii_alphanumeric() || b"_+-".contains(&byte);
    if local.is_empty()
        || local.starts_with('.')
        || text.contains("..")
        || !local
            .bytes()
            .all(|byte| local_end(byte) || b"'.".contains(&byte))
        || !local.as_bytes().last().copied().is_some_and(local_end)
    {
        return false;
    }
    let mut parts = domain.rsplit('.');
    let Some(tld) = parts.next() else {
        return false;
    };
    let labels: Vec<_> = parts.collect();
    tld.len() >= 2
        && tld.bytes().all(|byte| byte.is_ascii_alphabetic())
        && !labels.is_empty()
        && labels.iter().all(|label| {
            label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn digits(text: &[u8]) -> Option<u32> {
    if text.is_empty() || !text.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        text.iter()
            .fold(0, |n, digit| n * 10 + u32::from(digit - b'0')),
    )
}

fn date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (
        digits(&bytes[..4]),
        digits(&bytes[5..7]),
        digits(&bytes[8..]),
    ) else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    day > 0 && day <= days
}

fn datetime(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 17 || bytes[10] != b'T' || !date(&text[..10]) {
        return false;
    }
    let end = if bytes.last() == Some(&b'Z') {
        bytes.len() - 1
    } else {
        let at = bytes.len() - 6;
        if !matches!(bytes[at], b'+' | b'-')
            || bytes[at + 3] != b':'
            || !digits(&bytes[at + 1..at + 3]).is_some_and(|n| n < 24)
            || !digits(&bytes[at + 4..]).is_some_and(|n| n < 60)
        {
            return false;
        }
        at
    };
    let time = &bytes[11..end];
    if time.len() < 5
        || time[2] != b':'
        || !digits(&time[..2]).is_some_and(|n| n < 24)
        || !digits(&time[3..5]).is_some_and(|n| n < 60)
    {
        return false;
    }
    if time.len() == 5 {
        return true;
    }
    if time.len() < 8 || time[5] != b':' || !digits(&time[6..8]).is_some_and(|n| n < 60) {
        return false;
    }
    time.len() == 8 || time[8] == b'.' && time.len() > 9 && time[9..].iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_formats_accept_the_servers_boundary_neighbours() {
        for text in ["0000-02-29", "2000-02-29", "2026-12-31"] {
            assert!(date(text), "{text}");
        }
        for text in [
            "1900-02-29",
            "2026-02-30",
            "2026-04-31",
            "2026-1-01",
            "２０２６-01-01",
        ] {
            assert!(!date(text), "{text}");
        }
        for text in [
            "2026-01-01T00:00Z",
            "2026-01-01T23:59:59.123456789Z",
            "0000-02-29T00:00-23:59",
        ] {
            assert!(datetime(text), "{text}");
        }
        for text in [
            "2026-01-01T24:00Z",
            "2026-01-01T00:60Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01T00:00z",
            "2026-01-01T00:00+24:00",
            "2026-01-01T00:00:00.Z",
            "2026-01-01T00:00:00",
            "2026-01-01T0000Z",
        ] {
            assert!(!datetime(text), "{text}");
        }
        for text in [
            "a@example.test",
            "a+b@example.test",
            "a'b@example.test",
            "a@domain-.test",
        ] {
            assert!(email(text), "{text}");
        }
        for text in [
            "a..b@example.test",
            "a.@example.test",
            ".a@example.test",
            "a@localhost",
            "a@domain.t",
            "a@-domain.test",
            "ü@example.test",
            "a@例子.test",
        ] {
            assert!(!email(text), "{text}");
        }
    }

    #[test]
    fn default_caps_and_thumbnail_caps_refuse_one_past_the_accepted_limit() {
        use base64::Engine;
        let definition = serde_json::json!({});
        assert_eq!(
            field("string", &definition, &Value::String("x".repeat(100_000))).unwrap(),
            None
        );
        assert!(
            field("string", &definition, &Value::String("x".repeat(100_001)))
                .unwrap()
                .is_some()
        );
        assert_eq!(
            field(
                "array",
                &definition,
                &Value::Array(vec![Value::Null; 10_000])
            )
            .unwrap(),
            None
        );
        assert!(
            field(
                "array",
                &definition,
                &Value::Array(vec![Value::Null; 10_001])
            )
            .unwrap()
            .is_some()
        );
        let image = |size| {
            let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
            bytes.resize(size, 0);
            Value::String(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        };
        assert_eq!(
            field("thumbnail", &definition, &image(THUMBNAIL_MAX_BYTES)).unwrap(),
            None
        );
        assert!(
            field("thumbnail", &definition, &image(THUMBNAIL_MAX_BYTES + 1))
                .unwrap()
                .is_some()
        );
        for uri in [
            "data:image/jpeg;base64,/9j/",
            "data:image/webp;base64,UklGRgAAAABXRUJQ",
        ] {
            assert_eq!(
                field("thumbnail", &definition, &Value::String(uri.into())).unwrap(),
                None
            );
        }
        for uri in [
            "data:image/jpeg;base64,iVBORw0KGgo=",
            "data:image/png;base64,iVBORw0KGgp=",
            "data:image/svg+xml;base64,iVBORw0KGgo=",
        ] {
            assert!(
                field("thumbnail", &definition, &Value::String(uri.into()))
                    .unwrap()
                    .is_some()
            );
        }
    }

    #[test]
    fn enums_with_no_values_use_string_rules_and_populated_enums_use_only_membership() {
        let open = serde_json::json!({"enum_values": [], "maxLength": 2});
        assert_eq!(
            field("enum", &open, &serde_json::json!("ok")).unwrap(),
            None
        );
        assert!(
            field("enum", &open, &serde_json::json!("long"))
                .unwrap()
                .is_some()
        );
        assert!(
            field("enum", &open, &serde_json::json!("\u{0000}"))
                .unwrap()
                .is_some()
        );
        let closed = serde_json::json!({"enum_values": ["long", "\u{0000}"], "maxLength": 2});
        assert_eq!(
            field("enum", &closed, &serde_json::json!("long")).unwrap(),
            None
        );
        assert_eq!(
            field("enum", &closed, &serde_json::json!("\u{0000}")).unwrap(),
            None
        );
    }
}
