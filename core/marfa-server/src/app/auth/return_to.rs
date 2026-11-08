//! Where a sign-in may send a browser, read as a browser would read `return_to`.

fn is_dot(segment: &str) -> bool {
    segment == "." || segment.eq_ignore_ascii_case("%2e")
}

fn is_dot_dot(segment: &str) -> bool {
    let lowered = segment.to_ascii_lowercase();
    matches!(lowered.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
}

fn without_dots(path: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    let last = segments.len().saturating_sub(1);
    for (index, segment) in segments.into_iter().enumerate() {
        if is_dot_dot(segment) {
            kept.pop();
            if index == last {
                kept.push("");
            }
        } else if is_dot(segment) {
            if index == last {
                kept.push("");
            }
        } else {
            kept.push(segment);
        }
    }
    format!("/{}", kept.join("/"))
}

fn after_origin<'t>(text: &'t str, origin: &str) -> Option<&'t str> {
    let head = text.get(..origin.len())?;
    let rest = &text[origin.len()..];
    let ends_there = rest.is_empty() || rest.starts_with(['/', '?', '#']);
    (head.eq_ignore_ascii_case(origin) && ends_there).then_some(rest)
}

fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once(':') else {
        return false;
    };
    let mut bytes = scheme.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"+-.".contains(&byte))
}

/// Whether a proxy that decodes a path could read this one as another host.
fn hides_a_host(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    let decoded = lowered.replace("%2f", "/").replace("%5c", "/");
    decoded.starts_with("//")
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if (0x21..=0x7e).contains(&byte) && !b"\"<>`".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn kept(value: &str, origin: &str) -> String {
    const HOME: &str = "/";
    let trimmed = value.trim_matches(|c: char| c <= ' ');
    let text: String = trimmed
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    if text.is_empty() || text.chars().any(char::is_control) {
        return HOME.to_string();
    }
    let path_end = text.find(['?', '#']).unwrap_or(text.len());
    let (path, tail) = text.split_at(path_end);
    let slashed = format!("{}{tail}", path.replace('\\', "/"));
    let local = if has_scheme(&slashed) {
        match after_origin(&slashed, origin) {
            Some(rest) => rest.to_string(),
            None => return HOME.to_string(),
        }
    } else if slashed.starts_with("//") {
        return HOME.to_string();
    } else {
        slashed
    };
    let path_end = local.find(['?', '#']).unwrap_or(local.len());
    let (path, tail) = local.split_at(path_end);
    let rooted = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let resolved = without_dots(&rooted);
    if hides_a_host(&resolved) {
        return HOME.to_string();
    }
    escaped(&format!("{resolved}{tail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://marfa.example";

    #[test]
    fn only_a_path_on_the_instance_is_kept() {
        for hostile in [
            "//evil.example",
            "/\\evil.example",
            "\\\\evil.example",
            "/\t/evil.example",
            "/\n/evil.example",
            " //evil.example",
            "/.//evil.example",
            "/a/..//evil.example",
            "/%2e//evil.example",
            "/%2E%2e//evil.example",
            "/.\\/evil.example",
            "/%2f/evil.example",
            "/%5Cevil.example",
            "%2f%2fevil.example",
            "https://evil.example/",
            "https:evil.example",
            "https:\\\\evil.example",
            "https://marfa.example@evil.example/",
            "https://marfa.example.evil.example/",
            "https://marfa.example//evil.example",
            "http://marfa.example/",
            "javascript:alert(1)",
            "data:text/html,x",
            "/a\u{0}b",
            "/a\u{7f}b",
            "",
        ] {
            assert_eq!(kept(hostile, ORIGIN), "/", "{hostile:?}");
        }
    }

    #[test]
    fn a_path_keeps_its_query_and_fragment() {
        for (value, wanted) in [
            (
                "/auth/device?from=sign-in#entry",
                "/auth/device?from=sign-in#entry",
            ),
            ("/a/../b/./c", "/b/c"),
            ("/a/b/..", "/a/"),
            ("a/b", "/a/b"),
            ("https://marfa.example/a?b#c", "/a?b#c"),
            ("HTTPS://MARFA.example/a", "/a"),
            ("https://marfa.example", "/"),
            ("/a?next=//evil.example", "/a?next=//evil.example"),
            ("/a?b=\\c", "/a?b=\\c"),
            ("/caf\u{e9}", "/caf%C3%A9"),
            ("/a b", "/a%20b"),
        ] {
            assert_eq!(kept(value, ORIGIN), wanted, "{value:?}");
        }
    }
}
