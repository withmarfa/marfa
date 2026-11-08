//! Which blobs a row's properties name.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

const HEX_LEN: usize = 64;
const ESCAPED_HEX: &str = "3a";

/// Every digest a string in `properties` holds, at any depth, as `sha256:` and its hex.
pub fn digests(properties: &Map<String, Value>) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for value in properties.values() {
        walk(value, &mut found);
    }
    found
}

fn walk(value: &Value, found: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => scan(text, found),
        Value::Array(values) => values.iter().for_each(|value| walk(value, found)),
        Value::Object(members) => members.values().for_each(|value| walk(value, found)),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// A run of lowercase hex counts when it is 64 long, or when it is `3a` and 64 more with `%`
/// before it, the tail of an escaped `sha256%3a`.
fn scan(text: &str, found: &mut BTreeSet<String>) {
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if !is_hex(bytes[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && is_hex(bytes[at]) {
            at += 1;
        }
        let run = &text[start..at];
        let escaped = run.len() == HEX_LEN + 2
            && run.starts_with(ESCAPED_HEX)
            && start > 0
            && bytes[start - 1] == b'%';
        if run.len() == HEX_LEN {
            found.insert(format!("sha256:{run}"));
        } else if escaped {
            found.insert(format!("sha256:{}", &run[2..]));
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn found(value: Value) -> Vec<String> {
        let Value::Object(properties) = value else {
            panic!("properties are an object");
        };
        digests(&properties).into_iter().collect()
    }

    fn one() -> Vec<String> {
        vec![format!("sha256:{HEX}")]
    }

    #[test]
    fn counts_a_run_of_exactly_sixty_four_in_every_form() {
        for text in [
            HEX.to_string(),
            format!("sha256:{HEX}"),
            format!("![it](sha256:{HEX}) and more"),
            format!("sha256%3A{HEX}"),
            format!("sha256%3a{HEX}"),
            format!("/blobs/{HEX}?x"),
            format!("\"{HEX}\""),
            format!("{HEX}-tail"),
            format!("SHA{HEX}"),
        ] {
            assert_eq!(found(json!({ "body": text })), one(), "{text}");
        }
    }

    #[test]
    fn refuses_a_run_of_sixty_three_or_sixty_five() {
        for text in [
            HEX[1..].to_string(),
            format!("{HEX}0"),
            format!("0{HEX}"),
            format!("sha256:{HEX}f"),
            format!("x3a{HEX}"),
            format!("%3a0{HEX}"),
            format!("%3b{HEX}"),
        ] {
            assert!(found(json!({ "body": text })).is_empty(), "{text}");
        }
    }

    #[test]
    fn counts_the_escaped_tail_only_after_a_percent() {
        assert_eq!(found(json!({ "a": format!("%3a{HEX}") })), one());
        assert_eq!(
            found(json!({ "a": format!("3a{HEX}") })),
            Vec::<String>::new()
        );
    }

    #[test]
    fn walks_every_depth_and_reads_values_not_names() {
        let other = HEX.replace('0', "f");
        let properties = json!({
            "title": "plain",
            "list": [1, null, true, { "deep": [format!("sha256:{HEX}")] }],
            "nested": { "again": format!("x {other} y") },
            HEX: "a name is not a value",
        });
        assert_eq!(
            found(properties),
            vec![format!("sha256:{HEX}"), format!("sha256:{other}")]
        );
    }

    #[test]
    fn counts_several_in_one_string_once_each() {
        let other = HEX.replace('1', "e");
        let text = format!("{HEX} {other} {HEX}");
        assert_eq!(found(json!({ "body": text })).len(), 2);
    }

    #[test]
    fn reads_text_that_is_not_ascii() {
        assert_eq!(found(json!({ "body": format!("é{HEX}ü") })), one());
        assert_eq!(
            found(json!({ "body": format!("é3a{HEX}") })),
            Vec::<String>::new()
        );
    }
}
