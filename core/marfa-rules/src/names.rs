//! Names compare in NFC, case-insensitively, as macOS and Obsidian do.

use unicode_normalization::UnicodeNormalization;

pub fn folded(name: &str) -> String {
    // A lowercase mapping can leave a sequence that composes differently.
    name.nfc().flat_map(char::to_lowercase).nfc().collect()
}

/// Longest name, in UTF-16 code units, that has a title key.
pub const MAX_NAME_UNITS: usize = 1000;

pub fn title_key(title: &str) -> Option<String> {
    let trimmed = title.trim();
    let named = !trimmed.is_empty() && trimmed.encode_utf16().count() <= MAX_NAME_UNITS;
    named.then(|| folded(trimmed))
}

pub fn same(one: &str, other: &str) -> bool {
    folded(one) == folded(other)
}

pub fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn title_of(path: &str) -> String {
    let name = name_of(path);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_differing_only_in_case_or_form_are_one() {
        let composed = "Caf\u{e9}";
        let decomposed = "Cafe\u{301}";
        assert_ne!(composed, decomposed);
        assert!(same(composed, decomposed));
        assert!(same("PLAN.md", "plan.md"));
        assert!(same("\u{c9}t\u{e9}", "e\u{301}te\u{301}"));
        assert!(!same("plan.md", "plans.md"));
    }
}
