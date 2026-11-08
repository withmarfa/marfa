//! The grammar of a type identifier, which a server and a client hold a name
//! to.

use crate::error::RuleError;

/// What a type is, said where a name is refused for breaking the grammar.
pub const GRAMMAR: &str = "a type is two or more lowercase dotted segments, each a letter followed by letters, digits, hyphens and underscores, at most 128 characters, with exactly three under `app.` and none under a root Marfa reserves";

/// The server's type pattern grammar (`types/id-grammar` and
/// `types/id-reserved-scope-root`): a type identifier, or a namespace under
/// `.*`. The bare `*` is no pattern here; each caller says what it means.
pub fn type_pattern(name: &str) -> Result<bool, RuleError> {
    let segment = |part: &str| {
        let mut characters = part.chars();
        characters
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
            && characters.all(|rest| {
                rest.is_ascii_lowercase() || rest.is_ascii_digit() || rest == '-' || rest == '_'
            })
    };
    if name.len() > 128 {
        return Ok(false);
    }
    // A wildcard's root is a namespace, held to the segments alone.
    if let Some(root) = name.strip_suffix(".*") {
        return Ok(!root.is_empty() && root.split('.').all(segment));
    }
    let segments: Vec<&str> = name.split('.').collect();
    if segments.len() < 2 || !segments.iter().all(|part| segment(part)) {
        return Ok(false);
    }
    Ok(match segments[0] {
        "app" => segments.len() == 3,
        "core" | "system" | "user" | "marfa" => true,
        root => !crate::builtin::reserved_type_roots()?
            .iter()
            .any(|reserved| reserved == root),
    })
}

/// A type identifier the server's grammar takes, and no namespace pattern.
pub fn type_id(name: &str) -> Result<bool, RuleError> {
    Ok(!name.ends_with(".*") && type_pattern(name)?)
}

/// The root of a type identifier that only Marfa's own build may create, where
/// `name` begins with one.
pub fn platform_root(name: &str) -> Option<&'static str> {
    match name.split('.').next() {
        Some("core") => Some("core"),
        Some("system") => Some("system"),
        Some("marfa") => Some("marfa"),
        _ => None,
    }
}
