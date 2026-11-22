//! Tool payloads appear as structured content and JSON text.

use serde_json::{Map, Value, json};

use crate::app::refusal::Refusal;
use crate::http::answer::refusal_body;

/// Bounds read answers so clients can hand them to the model whole.
pub const ANSWER_BUDGET_CHARS: usize = 40_000;

pub type Outcome = std::result::Result<Value, Stop>;

/// A failure tracks prior writes to prevent an unsafe step-up retry.
pub struct Stop(Box<Detail>);

pub struct Detail {
    pub error: Map<String, Value>,
    pub refusal: Option<Refusal>,
    pub wrote: bool,
}

impl std::ops::Deref for Stop {
    type Target = Detail;

    fn deref(&self) -> &Detail {
        &self.0
    }
}

impl std::ops::DerefMut for Stop {
    fn deref_mut(&mut self) -> &mut Detail {
        &mut self.0
    }
}

fn hint_for(code: &str) -> Option<&'static str> {
    Some(match code {
        "version_conflict" => {
            "Read the item again with marfa_get, decide whether your change still applies, and send the version you read."
        }
        "item_not_found" => {
            "The item does not exist or this credential cannot read it. Find it again with marfa_find."
        }
        "type_not_permitted" => "This credential's grant does not reach this type.",
        "unknown_type" => "No type has this identifier on this instance. Check the spelling.",
        "validation_error" => {
            "Check the arguments against the tool's input schema and the type's fields."
        }
        "rate_limited" => "Wait before calling again.",
        _ => return None,
    })
}

impl Stop {
    pub fn coded(code: &str, message: impl Into<String>) -> Stop {
        let mut error = Map::new();
        error.insert("code".into(), code.into());
        error.insert("message".into(), Value::String(message.into()));
        Stop(Box::new(Detail {
            error,
            refusal: None,
            wrote: false,
        }))
    }

    pub fn invalid(message: impl Into<String>) -> Stop {
        Stop::coded("validation_error", message)
    }

    /// Converts a refusal to a tool error.
    pub fn refused(refusal: Refusal) -> Stop {
        let body = serde_json::from_slice::<Value>(&refusal_body(&refusal)).unwrap_or(Value::Null);
        let mut error = match body.get("error").cloned() {
            Some(Value::Object(error)) => error,
            _ => Map::new(),
        };
        error.remove("status");
        if let Some(hint) = hint_for(refusal.code.wire()) {
            error.insert("hint".into(), hint.into());
        }
        Stop(Box::new(Detail {
            error,
            refusal: Some(refusal),
            wrote: false,
        }))
    }

    pub fn with(mut self, name: &str, value: impl Into<Value>) -> Stop {
        self.error.insert(name.to_string(), value.into());
        self
    }

    pub fn wrote(mut self, wrote: bool) -> Stop {
        self.wrote = wrote;
        self
    }
}

impl From<Refusal> for Stop {
    fn from(refusal: Refusal) -> Stop {
        Stop::refused(refusal)
    }
}

/// The result of a `tools/call`, as the protocol carries it.
pub fn call_result(outcome: &Outcome) -> Value {
    match outcome {
        Ok(payload) => json!({
            "content": [{ "type": "text", "text": text_of(payload) }],
            "structuredContent": payload,
        }),
        Err(stop) => json!({
            "content": [{
                "type": "text",
                "text": text_of(&json!({ "error": stop.error })),
            }],
            "isError": true,
        }),
    }
}

fn text_of(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// How long `value` is as JSON text, in the UTF-16 units a client counts it in.
pub fn json_length(value: &Value) -> usize {
    text_of(value).encode_utf16().count()
}

/// The leading entries whose JSON text fits `room`, and how many were left out.
pub fn fit_list(entries: Vec<Value>, room: usize) -> (Vec<Value>, usize) {
    let total = entries.len();
    let mut used = 2;
    let mut kept = Vec::new();
    for entry in entries {
        let width = json_length(&entry) + 1;
        if used + width > room {
            break;
        }
        used += width;
        kept.push(entry);
    }
    let left_out = total - kept.len();
    (kept, left_out)
}

/// A page whose `data` fits `room`, read again with fewer rows until it does, so that its own
/// `next_cursor` continues right after the last row the answer holds.
pub async fn fitted_page<Read, Page>(
    mut limit: i64,
    room: usize,
    mut read: Read,
) -> Result<Value, Stop>
where
    Read: FnMut(i64) -> Page,
    Page: Future<Output = Result<Value, Stop>>,
{
    loop {
        let page = read(limit).await?;
        let rows = page["data"].as_array().cloned().unwrap_or_default();
        let (kept, left_out) = fit_list(rows, room);
        if left_out == 0 || limit <= 1 {
            return Ok(page);
        }
        limit = i64::try_from(kept.len()).unwrap_or(1).max(1);
    }
}

fn json_width(point: char) -> usize {
    match point {
        '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
        point if (point as u32) < 0x20 => 6,
        point => point.len_utf16(),
    }
}

pub struct Part {
    pub text: String,
    pub next_offset: Option<usize>,
    pub total_chars: usize,
}

/// Cuts at code-point boundaries within the encoded JSON budget.
pub fn cut_text(text: &str, offset: usize, room: usize) -> Part {
    let points: Vec<char> = text.chars().collect();
    let start = offset.min(points.len());
    let mut end = start;
    let mut used = 0;
    while let Some(point) = points.get(end) {
        let width = json_width(*point);
        if used + width > room {
            break;
        }
        used += width;
        end += 1;
    }
    Part {
        text: points[start..end].iter().collect(),
        next_offset: (end < points.len()).then_some(end),
        total_chars: points.len(),
    }
}

/// Validates the subset of JSON Schema used by tool inputs.
pub fn check(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let at = if path.is_empty() {
        "the arguments"
    } else {
        path
    };
    if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
        return one_of(options, value, path, at);
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let fits = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "integer" => value.is_i64() || value.is_u64(),
            _ => true,
        };
        if !fits {
            return Err(format!("{at} must be of type {kind}."));
        }
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        let names: Vec<String> = allowed
            .iter()
            .filter_map(|name| name.as_str().map(str::to_string))
            .collect();
        return Err(format!("{at} must be one of {}.", names.join(", ")));
    }
    if let Some(text) = value.as_str() {
        let shortest = schema.get("minLength").and_then(Value::as_u64).unwrap_or(0);
        let length = text.chars().count() as u64;
        if length < shortest {
            return Err(format!("{at} must not be empty."));
        }
        if let Some(longest) = schema.get("maxLength").and_then(Value::as_u64)
            && length > longest
        {
            return Err(format!("{at} holds at most {longest} characters."));
        }
    }
    if let Some(number) = value.as_f64() {
        if let Some(least) = schema.get("minimum").and_then(Value::as_f64)
            && number < least
        {
            return Err(format!("{at} must be at least {least}."));
        }
        if let Some(most) = schema.get("maximum").and_then(Value::as_f64)
            && number > most
        {
            return Err(format!("{at} must be at most {most}."));
        }
    }
    if let Some(list) = value.as_array() {
        let fewest = schema.get("minItems").and_then(Value::as_u64).unwrap_or(0);
        if (list.len() as u64) < fewest {
            return Err(format!("{at} must hold at least {fewest} items."));
        }
        if let Some(most) = schema.get("maxItems").and_then(Value::as_u64)
            && list.len() as u64 > most
        {
            return Err(format!("{at} must hold at most {most} items."));
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            let mut seen: Vec<&Value> = Vec::new();
            for item in list {
                if seen.contains(&item) {
                    return Err(format!("{at} must list each value once."));
                }
                seen.push(item);
            }
        }
        if let Some(items) = schema.get("items") {
            for (index, item) in list.iter().enumerate() {
                check(items, item, &format!("{path}[{index}]"))?;
            }
        }
    }
    if let Some(object) = value.as_object() {
        let declared = schema.get("properties").and_then(Value::as_object);
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    return Err(format!("{} is required.", member(path, name)));
                }
            }
        }
        let open = schema.get("additionalProperties");
        let mut unknown: Vec<&str> = Vec::new();
        for (name, inner) in object {
            match declared.and_then(|declared| declared.get(name)) {
                Some(inner_schema) => check(inner_schema, inner, &member(path, name))?,
                None => match open {
                    Some(Value::Bool(false)) => unknown.push(name),
                    Some(schema @ Value::Object(_)) => check(schema, inner, &member(path, name))?,
                    _ => {}
                },
            }
        }
        if !unknown.is_empty() {
            unknown.sort_unstable();
            return Err(format!(
                "{at} names {} this tool does not take: {}.",
                if unknown.len() == 1 {
                    "an argument"
                } else {
                    "arguments"
                },
                unknown.join(", ")
            ));
        }
    }
    Ok(())
}

fn one_of(options: &[Value], value: &Value, path: &str, at: &str) -> Result<(), String> {
    let mut matched = 0;
    let mut same_type: Vec<String> = Vec::new();
    let mut other: Vec<String> = Vec::new();
    for option in options {
        match check(option, value, path) {
            Ok(()) => matched += 1,
            Err(message) => {
                let declared = option.get("type").and_then(Value::as_str);
                if declared.is_none() || declared == Some(json_kind(value)) {
                    same_type.push(message);
                } else {
                    other.push(message);
                }
            }
        }
    }
    if matched == 1 {
        return Ok(());
    }
    same_type
        .into_iter()
        .chain(other)
        .next()
        .map_or_else(|| Err(format!("{at} matches no accepted form.")), Err)
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Object(_) => "object",
        Value::Array(_) => "array",
        Value::String(_) => "string",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::Null => "null",
    }
}

fn member(path: &str, name: &str) -> String {
    if path.is_empty() {
        name.to_string()
    } else {
        format!("{path}.{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_counts_what_a_json_string_costs() {
        let part = cut_text("a\"b\nc", 0, 4);
        assert_eq!(part.text, "a\"b");
        assert_eq!(part.next_offset, Some(3));
        assert_eq!(part.total_chars, 5);
        let rest = cut_text("a\"b\nc", 3, 100);
        assert_eq!(rest.text, "\nc");
        assert_eq!(rest.next_offset, None);
    }

    #[test]
    fn a_list_keeps_the_entries_that_fit_and_counts_the_rest() {
        let entries: Vec<Value> = (0..5).map(|n| json!({ "n": n })).collect();
        let (kept, left_out) = fit_list(entries.clone(), 1_000);
        assert_eq!((kept.len(), left_out), (5, 0));
        let (kept, left_out) = fit_list(entries, 20);
        assert_eq!(kept.len() + left_out, 5);
        assert!(left_out > 0 && !kept.is_empty());
        assert!(json_length(&Value::Array(kept)) <= 20);
    }

    #[test]
    fn an_argument_the_schema_does_not_name_is_named_back() {
        let schema = json!({
            "type": "object",
            "properties": { "type": { "type": "string", "minLength": 1 } },
            "additionalProperties": false,
        });
        let error = check(&schema, &json!({ "typ": "core.note" }), "").unwrap_err();
        assert!(error.contains("typ"), "{error}");
        assert!(check(&schema, &json!({ "type": "core.note" }), "").is_ok());
        assert!(check(&schema, &json!({ "type": "" }), "").is_err());
    }

    #[test]
    fn a_type_argument_that_is_not_one_string_or_a_short_list_of_them_is_named() {
        let schema = json!({
            "type": "object",
            "properties": {
                "type": {
                    "oneOf": [
                        { "type": "string", "minLength": 1 },
                        {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 20,
                            "uniqueItems": true,
                            "items": { "type": "string", "minLength": 1 },
                        },
                    ],
                },
            },
            "additionalProperties": false,
        });
        assert!(check(&schema, &json!({ "type": "core.note" }), "").is_ok());
        assert!(check(&schema, &json!({ "type": ["core.note", "core.task"] }), "").is_ok());
        for value in [
            json!({ "type": [] }),
            json!({ "type": (0..21).map(|n| format!("user.t{n}")).collect::<Vec<_>>() }),
            json!({ "type": ["core.note", "core.note"] }),
            json!({ "type": ["core.note", 1] }),
        ] {
            let error = check(&schema, &value, "").unwrap_err();
            assert!(error.contains("type"), "{error}");
        }
    }

    #[test]
    fn a_string_longer_than_its_schema_allows_is_refused() {
        let schema = json!({ "type": "string", "maxLength": 3 });
        assert!(check(&schema, &json!("abc"), "q").is_ok());
        assert!(check(&schema, &json!("ééé"), "q").is_ok());
        let error = check(&schema, &json!("abcd"), "q").unwrap_err();
        assert!(error.contains("at most 3"), "{error}");
    }

    /// Rows `0..total`, newest first, read `limit` at a time; the cursor names the next row.
    fn page_of(total: i64, limit: i64, width: usize) -> Value {
        let rows: Vec<Value> = (0..total.min(limit))
            .map(|row| json!({ "row": row, "pad": "x".repeat(width) }))
            .collect();
        let next = (limit < total).then(|| limit.to_string());
        json!({ "data": rows, "next_cursor": next })
    }

    #[tokio::test]
    async fn a_page_too_long_for_its_room_is_read_again_shorter_so_its_cursor_follows_its_last_row()
    {
        let mut asked = Vec::new();
        let page = fitted_page(20, 1_000, |limit| {
            asked.push(limit);
            std::future::ready(Ok(page_of(20, limit, 200)))
        })
        .await
        .unwrap_or_else(|_| panic!("the page reads"));
        let rows = page["data"].as_array().map_or(0, Vec::len);
        assert_eq!(rows, 4);
        assert_eq!(page["next_cursor"], "4");
        assert_eq!(asked, [20, 4]);
        // The witness: a page that fits is read once and answered whole.
        let mut asked = Vec::new();
        let whole = fitted_page(20, 100_000, |limit| {
            asked.push(limit);
            std::future::ready(Ok(page_of(20, limit, 200)))
        })
        .await
        .unwrap_or_else(|_| panic!("the page reads"));
        assert_eq!(whole["data"].as_array().map_or(0, Vec::len), 20);
        assert_eq!(asked, [20]);
    }

    #[tokio::test]
    async fn a_single_row_too_long_for_its_room_is_answered_with_its_cursor() {
        let page = fitted_page(5, 10, |limit| std::future::ready(Ok(page_of(5, limit, 50))))
            .await
            .unwrap_or_else(|_| panic!("the page reads"));
        assert_eq!(page["data"].as_array().map_or(0, Vec::len), 1);
        assert_eq!(page["next_cursor"], "1");
    }
}
