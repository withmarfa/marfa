use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::js;
use crate::model::{THUMBNAIL_MAX_BYTES, Thumbnail};
use crate::url_host;

/// Longest tag, in UTF-16 code units: the server's `MAX_TAG_LENGTH`. A tag is
/// removed through its own URL path, so one longer could be written and never
/// removed.
pub(crate) const MAX_TAG_LENGTH: usize = 128;

/// Most tags one item may hold: the server's `MAX_TAGS_PER_ITEM`.
pub(crate) const MAX_TAGS_PER_ITEM: usize = 100;

/// The tags a write may carry, as the server holds them: at most
/// `MAX_TAGS_PER_ITEM` of them, duplicates counted, each not empty, not blank
/// as JavaScript's `trim` reads blank, not `.` or `..`, which a URL path
/// cannot name as a segment, and at most `MAX_TAG_LENGTH` UTF-16 code units.
/// A write the server would refuse is refused here, so it is never saved or
/// queued only to come back refused.
pub(crate) fn tags(tags: &[String]) -> Result<(), CoreError> {
    let mut errors: Vec<String> = tags
        .iter()
        .enumerate()
        .filter_map(|(index, tag)| {
            let problem = if tag.is_empty() {
                "A tag must not be empty".to_string()
            } else if tag.chars().all(js::is_space) {
                "A tag must not be blank".to_string()
            } else if tag == "." || tag == ".." {
                format!("A tag must not be {tag:?}, which a URL path cannot name")
            } else if tag.encode_utf16().count() > MAX_TAG_LENGTH {
                format!("A tag must contain at most {MAX_TAG_LENGTH} UTF-16 code units")
            } else {
                return None;
            };
            Some(format!("tags[{index}]: {problem}"))
        })
        .collect();
    if tags.len() > MAX_TAGS_PER_ITEM {
        errors.insert(
            0,
            format!("tags: Maximum {MAX_TAGS_PER_ITEM} tags per item"),
        );
    }
    refuse(errors)
}

/// The server refuses a tag write that leaves an item more tags than the
/// bound only where it holds more than it did, so a row an archive restored
/// over the bound can still shed them.
pub(crate) fn tag_count(before: usize, after: usize) -> Result<(), CoreError> {
    refuse(
        (after > MAX_TAGS_PER_ITEM && after > before)
            .then(|| {
                format!("tags: Maximum {MAX_TAGS_PER_ITEM} tags per item (including existing tags)")
            })
            .into_iter()
            .collect(),
    )
}

/// The property names a write may carry, as the server holds them: not empty.
pub(crate) fn property_names(properties: &Map<String, Value>) -> Result<(), CoreError> {
    refuse(
        properties
            .keys()
            .any(String::is_empty)
            .then(|| "properties: A property name must not be empty".to_string())
            .into_iter()
            .collect(),
    )
}

/// The properties an edit clears, refused as the server refuses them: an
/// empty name, and one the same edit also sets.
pub(crate) fn cleared_names(cleared: &[String], set: &Map<String, Value>) -> Result<(), CoreError> {
    let mut errors = Vec::new();
    if cleared.iter().any(String::is_empty) {
        errors.push("clear_properties: A property name must not be empty".to_string());
    }
    let both: Vec<&str> = cleared
        .iter()
        .filter(|name| set.contains_key(*name))
        .map(String::as_str)
        .collect();
    if !both.is_empty() {
        errors.push(format!(
            "A property can't be both set and cleared: {}",
            both.join(", ")
        ));
    }
    refuse(errors)
}

/// An id a write names, as the server's `isValidId` takes one: a lowercase
/// UUIDv7. The server refuses any other `400 invalid_id`, and then refuses a
/// read of it the same way, so a copy that queued one could never read the
/// row back to put itself right.
pub(crate) fn id(field: &str, id: &str) -> Result<(), CoreError> {
    let bytes = id.as_bytes();
    let hex = |b: &u8| b.is_ascii_digit() || (b'a'..=b'f').contains(b);
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => *b == b'-',
            14 => *b == b'7',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => hex(b),
        });
    if valid {
        Ok(())
    } else {
        Err(CoreError::Validation {
            code: "invalid_id".into(),
            message: format!("Invalid {field}: {id:?} is not a UUIDv7 in lowercase"),
        })
    }
}

fn refuse(errors: Vec<String>) -> Result<(), CoreError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CoreError::Validation {
            code: "validation_error".into(),
            message: errors.join("; "),
        })
    }
}

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
        "string" => match value.as_str() {
            None => expected("string"),
            // `currency` is the one format whose value is judged.
            Some(text) if definition.get("format").and_then(Value::as_str) == Some("currency") => currency(text),
            Some(text) => bounded(text),
        },
        // Whether the word is one the type declares is judged apart, only
        // where a write changes it (`Catalog::validate_merged`).
        "status" => field("string", &Value::Null, value)?,
        "enum" => match value.as_str() {
            None => expected("string"),
            Some(text) => match definition.get("enum_values").and_then(Value::as_array).filter(|values| !values.is_empty()) {
                Some(values) if !values.iter().any(|value| value.as_str() == Some(text)) => Some(format!("Must be one of {}", values.iter().map(Value::to_string).collect::<Vec<_>>().join(", "))),
                Some(_) => None,
                None => bounded(text),
            }
        },
        "number" => match value.as_f64().filter(|number| number.is_finite()) { Some(number) => in_range(definition, number), None => expected("number") },
        "integer" => match value.as_f64().filter(|number| number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0) { Some(number) => in_range(definition, number), None => expected("safe integer") },
        "boolean" => if value.is_boolean() { None } else { expected("boolean") },
        "array" => match value.as_array() {
            None => expected("array"),
            Some(values) if values.len() as u64 > limit("maxItems", 10_000) => Some(format!("Must contain at most {} items", limit("maxItems", 10_000))),
            Some(values) => elements(definition, values)?,
        },
        "object" => if value.is_object() { None } else { expected("object") },
        "url" => if value.as_str().is_some_and(|text| url_value(text).is_some()) { None } else { Some("Must be a valid URL".into()) },
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

/// A currency code as the server takes one: three capital letters from A to
/// Z. Whether ISO 4217 assigns the code is left alone, as that list changes.
fn currency(text: &str) -> Option<String> {
    let taken = text.len() == 3 && text.bytes().all(|byte| byte.is_ascii_uppercase());
    (!taken).then(|| "Must be a currency code of three capital letters".into())
}

/// Where `number` falls outside the `minimum` and `maximum` the field names,
/// both inclusive.
fn in_range(definition: &Value, number: f64) -> Option<String> {
    let bound = |key| definition.get(key).filter(|bound| bound.is_number());
    if let Some(minimum) =
        bound("minimum").filter(|minimum| minimum.as_f64().is_some_and(|minimum| number < minimum))
    {
        return Some(format!("Must be at least {minimum}"));
    }
    bound("maximum")
        .filter(|maximum| maximum.as_f64().is_some_and(|maximum| number > maximum))
        .map(|maximum| format!("Must be at most {maximum}"))
}

/// The first element of an array that is not a value of the field's
/// `items_type`, judged as a field of that type judges a value. An
/// `items_type` that names no field type leaves the elements unchecked, as the
/// server leaves them.
fn elements(definition: &Value, values: &[Value]) -> Result<Option<String>, CoreError> {
    let Some(items) = definition.get("items_type").and_then(Value::as_str) else {
        return Ok(None);
    };
    if let (true, Some(members)) = (
        items == "object",
        definition.get("items_fields").and_then(Value::as_object),
    ) {
        return entries(members, values);
    }
    let element = serde_json::json!({ "enum_values": definition.get("enum_values") });
    for (index, value) in values.iter().enumerate() {
        match field(items, &element, value) {
            // `field` fails only on a kind it does not know.
            Err(CoreError::Decoding(_)) => return Ok(None),
            checked => {
                if let Some(message) = checked? {
                    return Ok(Some(format!("Item {index}: {message}")));
                }
            }
        }
    }
    Ok(None)
}

/// The first entry of a list that is not an object with at least one member,
/// only members the field declares, every member it requires and a value for
/// each that a field of the member's definition takes. A member with no value
/// is left out, and a `null` is no value.
fn entries(members: &Map<String, Value>, values: &[Value]) -> Result<Option<String>, CoreError> {
    for (index, value) in values.iter().enumerate() {
        let refused = |message: String| Ok(Some(format!("Item {index}: {message}")));
        let Some(entry) = value.as_object() else {
            return refused("Expected object".into());
        };
        if entry.is_empty() {
            return refused("Must have at least one member".into());
        }
        if let Some(name) = entry.keys().find(|name| !members.contains_key(*name)) {
            return refused(format!("{name}: Is not a member of the entry"));
        }
        for (name, member) in members {
            let Some(held) = entry.get(name) else {
                if member.get("required").and_then(Value::as_bool) == Some(true) {
                    return refused(format!("{name}: Required"));
                }
                continue;
            };
            let kind = member.get("type").and_then(Value::as_str).ok_or_else(|| {
                CoreError::Decoding(format!("the held member {name} declares no type"))
            })?;
            if let Some(message) = field(kind, member, held)? {
                return refused(format!("{name}: {message}"));
            }
        }
    }
    Ok(None)
}

/// A `url` value as the server holds it, or `None` where the server refuses
/// it. The server trims the text as JavaScript's `trim` does, judges it as the
/// WHATWG URL standard does, and keeps it without the tabs and line breaks the
/// standard ignores. The `url` crate parts from the standard on some authorities,
/// which `url_host` corrects.
pub(crate) fn url_value(text: &str) -> Option<String> {
    let kept: String = text
        .trim_matches(js::is_space)
        .chars()
        .filter(|ch| !matches!(ch, '\t' | '\n' | '\r'))
        .collect();
    let taken = if url::Url::parse(&kept).is_ok() {
        !url_host::authority_is_refused(&kept)
    } else {
        url_host::ascii_host_is_taken(&kept)
    };
    taken.then_some(kept)
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
    fn an_id_is_taken_as_the_server_takes_one() {
        assert!(id("id", &uuid::Uuid::now_v7().to_string()).is_ok());
        assert!(id("id", "0199a9c4-7c1e-7d3a-9f2b-3c4d5e6f7a8b").is_ok());
        for refused in [
            "",
            "my-note-1",
            "0199A9C4-7C1E-7D3A-9F2B-3C4D5E6F7A8B",
            "0199a9c4-7c1e-4d3a-9f2b-3c4d5e6f7a8b",
            "0199a9c4-7c1e-7d3a-cf2b-3c4d5e6f7a8b",
            "0199a9c47c1e7d3a9f2b3c4d5e6f7a8b",
            "0199a9c4-7c1e-7d3a-9f2b-3c4d5e6f7a8b ",
            "0199a9c4-7c1e-7d3a-9f2b-3c4d5e6f7a8g",
        ] {
            assert_eq!(
                id("id", refused).map_err(|error| error.code().to_string()),
                Err("validation".into()),
                "{refused:?}"
            );
            assert!(matches!(
                id("id", refused),
                Err(CoreError::Validation { code, .. }) if code == "invalid_id"
            ));
        }
    }

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
    fn a_url_is_trimmed_and_judged_as_the_server_does() {
        // Each expectation is what the server answers: JavaScript's `trim`,
        // `URL.canParse` of the result, and the result without tabs and line
        // breaks as the stored value.
        for (text, stored) in [
            ("https://example.com/a", "https://example.com/a"),
            ("  https://example.com/a  ", "https://example.com/a"),
            (
                "\u{3000}https://example.com/a\u{3000}",
                "https://example.com/a",
            ),
            ("\u{feff}https://example.com/a", "https://example.com/a"),
            (
                "\u{feff}https://example.com/a\u{feff}",
                "https://example.com/a",
            ),
            (
                "\u{a0}https://example.com/a\u{2028}",
                "https://example.com/a",
            ),
            ("https://exa\tmple.com/a\nb\r", "https://example.com/ab"),
            ("ht\ttps://example.com", "https://example.com"),
            ("https://münchen.de/straße", "https://münchen.de/straße"),
            ("http://xn--mnchen-3ya.de/", "http://xn--mnchen-3ya.de/"),
            ("HTTP://XN--MNCHEN-3YA.DE/x", "HTTP://XN--MNCHEN-3YA.DE/x"),
            ("https://example.com/xn--", "https://example.com/xn--"),
            ("foo://xn--/", "foo://xn--/"),
            ("http://xn--", "http://xn--"),
            ("http://xn--/", "http://xn--/"),
            ("http://xn--%41", "http://xn--%41"),
            ("http://XN--%41/p", "http://XN--%41/p"),
            ("http://a.xn--%41.b:80/p", "http://a.xn--%41.b:80/p"),
            ("http://u@xn--%41/", "http://u@xn--%41/"),
            ("http://%78n--/", "http://%78n--/"),
            ("http://a.b.c.xn--pokxncvks", "http://a.b.c.xn--pokxncvks"),
            ("http://user:pw@xn--:8080/p", "http://user:pw@xn--:8080/p"),
            ("http://xn--xn---yna/", "http://xn--xn---yna/"),
            ("http://xn----pfa.xn--4db/", "http://xn----pfa.xn--4db/"),
            ("http:xn--", "http:xn--"),
            ("http:\\\\xn--\\p", "http:\\\\xn--\\p"),
            ("http://xn--!", "http://xn--!"),
            ("http://xn--%7E", "http://xn--%7E"),
            ("file://xn--/p", "file://xn--/p"),
            ("wss://xn--a.example/", "wss://xn--a.example/"),
            ("http://xn--a.1x/", "http://xn--a.1x/"),
            ("foo://h:80/p", "foo://h:80/p"),
            ("foo://u@h", "foo://u@h"),
            ("http://[::1]/", "http://[::1]/"),
            ("mailto:a@b.c", "mailto:a@b.c"),
            ("\u{1}https://example.com/", "\u{1}https://example.com/"),
        ] {
            assert_eq!(url_value(text).as_deref(), Some(stored), "{text:?}");
        }
        for text in [
            "\u{85}https://example.com/a",
            "not a url",
            "",
            "   ",
            "\u{200b}https://example.com",
            "http://bücher.xn--",
            "http://xn--a.münchen.de/",
            "http://xn--é/",
            "http://xn--%e9/",
            "http://xn--%c3%a9/",
            "http://xn--%2f/",
            "http://xn--%20/",
            "http://xn--%3a80/",
            "http://xn--%2541/",
            "http://xn--a%00/",
            "https://xn--a b/",
            "http://xn--[::1]/",
            "//example.com",
            "http://example.com:99999",
            "http://xn--a.1/",
            "http://xn--a.0x1/",
            "http://xn--a.1./",
            "http://xn--a.0x/",
            "foo://@",
            "foo://u@/p",
            "foo://h:80\\p",
            "foo://h:\\p",
            "foo://[::1]:80\\p",
        ] {
            assert_eq!(url_value(text), None, "{text:?}");
        }
    }

    #[test]
    fn an_array_element_is_judged_as_its_items_type_judges_a_value() {
        let list = |items: &str, values: Value| {
            field(
                "array",
                &serde_json::json!({ "items_type": items }),
                &values,
            )
            .unwrap()
        };
        for (items, good) in [
            ("string", serde_json::json!(["a", ""])),
            ("url", serde_json::json!(["https://example.test"])),
            ("email", serde_json::json!(["a@example.test"])),
            (
                "datetime",
                serde_json::json!(["2026-01-01T00:00Z", "2026-01-01"]),
            ),
            ("date", serde_json::json!(["2026-02-28"])),
            ("number", serde_json::json!([1.5, -2])),
            ("integer", serde_json::json!([3])),
            ("boolean", serde_json::json!([true, false])),
            ("object", serde_json::json!([{}, {"a": 1}])),
            ("array", serde_json::json!([[], [1, "x"]])),
            ("somethingelse", serde_json::json!([1, {}, null])),
            ("string", serde_json::json!([])),
        ] {
            assert_eq!(list(items, good.clone()), None, "{items} {good}");
        }
        for (items, bad) in [
            ("string", serde_json::json!(["a", 42])),
            ("string", serde_json::json!([{"x": 1}])),
            ("string", serde_json::json!([null])),
            ("string", serde_json::json!(["a\u{0}b"])),
            (
                "url",
                serde_json::json!(["https://example.test", "not a url"]),
            ),
            ("email", serde_json::json!(["nobody"])),
            ("datetime", serde_json::json!(["2026-01-01T00:00:00"])),
            ("date", serde_json::json!(["2026-02-30"])),
            ("number", serde_json::json!(["1"])),
            ("integer", serde_json::json!([1.5])),
            ("boolean", serde_json::json!(["true"])),
            ("object", serde_json::json!(["text"])),
            ("object", serde_json::json!([[]])),
            ("array", serde_json::json!([{}])),
        ] {
            let message = list(items, bad.clone());
            assert!(message.is_some(), "{items} {bad}");
        }
        assert!(
            list("string", serde_json::json!(["a", 1]))
                .unwrap()
                .starts_with("Item 1:")
        );
    }

    #[test]
    fn an_enum_element_takes_the_fields_enum_values() {
        let definition = serde_json::json!({"items_type": "enum", "enum_values": ["s", "m"]});
        assert_eq!(
            field("array", &definition, &serde_json::json!(["s", "m"])).unwrap(),
            None
        );
        assert!(
            field("array", &definition, &serde_json::json!(["xl"]))
                .unwrap()
                .is_some()
        );
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
    #[test]
    fn a_range_a_currency_and_the_entries_of_a_list_are_judged_as_the_server_judges_them() {
        use serde_json::json;
        let judged =
            |kind: &str, definition: Value, value: Value| field(kind, &definition, &value).unwrap();
        let score = json!({"minimum": 1, "maximum": 5});
        for good in [json!(1), json!(5), json!(3)] {
            assert_eq!(judged("integer", score.clone(), good), None);
        }
        for bad in [json!(0), json!(6), json!(5.5)] {
            assert!(judged("integer", score.clone(), bad).is_some());
        }
        let price = json!({"minimum": -0.5});
        assert_eq!(judged("number", price.clone(), json!(-0.5)), None);
        assert!(judged("number", price, json!(-0.51)).is_some());
        assert_eq!(judged("number", json!({}), json!(-1e300)), None);

        let code = json!({"format": "currency"});
        for good in ["GBP", "ZZZ"] {
            assert_eq!(judged("string", code.clone(), json!(good)), None, "{good}");
        }
        for bad in ["gbp", "GB", "GBPX", "", "GB1", "GBP\n", "\u{c9}UR"] {
            assert!(
                judged("string", code.clone(), json!(bad)).is_some(),
                "{bad:?}"
            );
        }
        assert!(judged("string", code, json!(826)).is_some());

        let contacts = json!({"items_type": "object", "items_fields": {
            "value": {"type": "email", "required": true},
            "rank": {"type": "integer", "minimum": 1, "maximum": 5},
        }});
        let entries = |value: Value| judged("array", contacts.clone(), value);
        assert_eq!(
            entries(json!([{"value": "a@example.test", "rank": 5}, {"value": "b@example.test"}])),
            None
        );
        assert_eq!(entries(json!([])), None);
        for bad in [
            json!([{"value": "a@example.test", "extra": 1}]),
            json!([{"rank": 1}]),
            json!([{"value": "no"}]),
            json!([{"value": "a@example.test", "rank": 6}]),
            json!([{"value": "a@example.test", "rank": null}]),
            json!([{}]),
            json!(["text"]),
        ] {
            assert!(
                entries(bad.clone()).is_some_and(|message| message.starts_with("Item 0:")),
                "{bad}"
            );
        }
        assert_eq!(
            entries(json!([{"value": "a@example.test"}, {"value": "a@example.test", "rank": 9}])),
            Some("Item 1: rank: Must be at most 5".into())
        );
    }
}
