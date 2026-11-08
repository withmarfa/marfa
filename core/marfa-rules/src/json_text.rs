use serde::de::IgnoredAny;

const MAX_DEPTH: usize = 64;

/// Whether `bytes` nests deeper than the limit; brackets inside strings do not count.
pub fn too_deep(bytes: &[u8]) -> bool {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in bytes {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return true;
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}

/// A string as JSON escapes it, U+FFFD for each lone surrogate, and whether it held one.
fn decoded(bytes: &[u8], mut at: usize) -> (String, bool, usize) {
    let hex = |at: usize| -> Option<u32> {
        let digits = bytes.get(at..at + 4)?;
        u32::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
    };
    let mut text: Vec<u8> = Vec::new();
    let mut lone = false;
    let push = |text: &mut Vec<u8>, ch: char| {
        text.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
    };
    while at < bytes.len() && bytes[at] != b'"' {
        if bytes[at] != b'\\' {
            text.push(bytes[at]);
            at += 1;
            continue;
        }
        match bytes.get(at + 1) {
            Some(b'u') => {
                let unit = hex(at + 2).unwrap_or(0);
                at += 6;
                let low = (bytes.get(at..at + 2) == Some(b"\\u"))
                    .then(|| hex(at + 2))
                    .flatten()
                    .filter(|low| (0xdc00..0xe000).contains(low));
                let ch = match (unit, low) {
                    (0xd800..=0xdbff, Some(low)) => {
                        at += 6;
                        char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00))
                    }
                    (0xd800..=0xdfff, _) => None,
                    _ => char::from_u32(unit),
                };
                lone |= ch.is_none();
                push(&mut text, ch.unwrap_or('\u{fffd}'));
            }
            Some(escape) => {
                push(
                    &mut text,
                    match escape {
                        b'n' => '\n',
                        b't' => '\t',
                        b'r' => '\r',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        other => char::from(*other),
                    },
                );
                at += 2;
            }
            None => at += 1,
        }
    }
    (String::from_utf8_lossy(&text).into_owned(), lone, at)
}

fn pointer<'a>(path: impl Iterator<Item = &'a String>) -> String {
    path.map(|step| format!("/{}", step.replace('~', "~0").replace('/', "~1")))
        .collect()
}

/// JSON pointer of the first string or key holding a lone surrogate.
pub fn ill_formed_at(bytes: &[u8]) -> Option<String> {
    if !bytes
        .windows(3)
        .any(|w| matches!(w, [b'\\', b'u', b'd' | b'D']))
    {
        return None;
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
                let (text, lone, end) = decoded(bytes, at + 1);
                if expecting_key && let Some((true, name)) = frames.last_mut() {
                    *name = text;
                }
                if lone {
                    return serde_json::from_slice::<IgnoredAny>(bytes)
                        .is_ok()
                        .then(|| pointer(frames.iter().map(|(_, name)| name)));
                }
                at = end;
            }
            _ => {}
        }
        at += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nesting_counts_brackets_outside_strings_only() {
        let at_limit = format!("{}{}", "[".repeat(64), "]".repeat(64));
        let past_it = format!("{}{}", "[".repeat(65), "]".repeat(65));
        assert!(!too_deep(at_limit.as_bytes()));
        assert!(too_deep(past_it.as_bytes()));
        let quoted = format!("\"{}\"", "[".repeat(100));
        assert!(!too_deep(quoted.as_bytes()));
        let escaped = format!("[\"\\\"{}\"]", "[".repeat(100));
        assert!(!too_deep(escaped.as_bytes()));
    }

    #[test]
    fn text_is_named_by_its_pointer() {
        for (body, expected) in [
            (r#"{"a":"\ud800"}"#, Some("/a")),
            (r#"{"a":"\uDC00"}"#, Some("/a")),
            (r#"{"a":"\udc00\ud800"}"#, Some("/a")),
            (r#"{"a":{"b":[1,"x","\ud83d"]}}"#, Some("/a/b/2")),
            (r#"{"a/b~c":"\ud800"}"#, Some("/a~1b~0c")),
            (r#"{"\ud800k":1}"#, Some("/\u{fffd}k")),
            (r#"{"a":"😀 \ud83d\ude00"}"#, None),
            (r#"{"a":"\\ud800"}"#, None),
            (r#"{"a":"\ud800"#, None),
            ("{\"a\":\"\\ud800\"} trailing", None),
        ] {
            assert_eq!(
                ill_formed_at(body.as_bytes()).as_deref(),
                expected,
                "{body}"
            );
        }
    }
}
